import AppKit
import CoreGraphics
import CoreMedia
import Dispatch
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import Vision

// LocWarp's screen OCR helper is deliberately a small newline-delimited JSON
// process. It never writes a captured frame to disk or sends a frame over the
// wire: ScreenCaptureKit delivers a pixel buffer, Vision reads it, and the
// pixel buffer is retained only while one OCR is in flight or one latest frame
// is waiting in memory. It is released when that work is finished or dropped.

private let helperVersion = "1"

private enum HelperError: LocalizedError {
    case invalidArgument(String)
    case invalidCommand(String)
    case invalidROI(String)
    case imageLoadFailed(String)
    case displayNotFound(UInt32)
    case noDisplays
    case captureUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidArgument(let message): return message
        case .invalidCommand(let message): return message
        case .invalidROI(let message): return message
        case .imageLoadFailed(let message): return message
        case .displayNotFound(let displayID): return "Display \(displayID) was not found."
        case .noDisplays: return "No capturable display was found."
        case .captureUnavailable(let message): return message
        }
    }
}

private final class JSONEmitter {
    private let lock = NSLock()

    func emit(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            emitRaw("{\"event\":\"error\",\"code\":\"serialization_error\",\"message\":\"Unable to encode helper output.\"}")
            return
        }
        emitRaw(String(decoding: data, as: UTF8.self))
    }

    private func emitRaw(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        let data = Data((line + "\n").utf8)
        FileHandle.standardOutput.write(data)
    }
}

private enum ROIUnits: String {
    case points
    case pixels
}

private struct ROI {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let units: ROIUnits
    let scale: Double?

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "units": units.rawValue
        ]
        if let scale {
            result["scale"] = scale
        }
        return result
    }

    static func parse(_ value: Any?, defaultUnits: ROIUnits = .points) throws -> ROI? {
        guard let value else { return nil }

        if let values = value as? [Any], values.count == 4 {
            guard let x = number(values[0]), let y = number(values[1]),
                  let width = number(values[2]), let height = number(values[3]) else {
                throw HelperError.invalidROI("ROI array must contain four numbers.")
            }
            return try make(x: x, y: y, width: width, height: height, units: defaultUnits, scale: nil)
        }

        guard let object = value as? [String: Any] else {
            throw HelperError.invalidROI("ROI must be an object or [x, y, width, height].")
        }
        guard let x = number(object["x"]), let y = number(object["y"]),
              let width = number(object["width"]), let height = number(object["height"]) else {
            throw HelperError.invalidROI("ROI requires numeric x, y, width and height.")
        }
        let units = ROIUnits(rawValue: (object["units"] as? String ?? defaultUnits.rawValue).lowercased()) ?? defaultUnits
        let scale = number(object["scale"] ?? object["retinaScale"])
        return try make(x: x, y: y, width: width, height: height, units: units, scale: scale)
    }

    private static func make(x: Double, y: Double, width: Double, height: Double, units: ROIUnits, scale: Double?) throws -> ROI {
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width > 0, height > 0 else {
            throw HelperError.invalidROI("ROI x/y/width/height must be finite and width/height must be positive.")
        }
        if let scale, (!scale.isFinite || scale <= 0 || scale > 16) {
            throw HelperError.invalidROI("ROI scale must be greater than 0 and no greater than 16.")
        }
        return ROI(x: x, y: y, width: width, height: height, units: units, scale: scale)
    }
}

private struct CaptureConfiguration {
    var displayID: UInt32?
    var roi: ROI?
    var fps: Double
    var scale: Double?
    var recognitionLevel: VNRequestTextRecognitionLevel

    static let `default` = CaptureConfiguration(
        displayID: nil,
        roi: nil,
        fps: 6,
        scale: nil,
        recognitionLevel: .fast
    )

    var levelName: String {
        recognitionLevel == .accurate ? "accurate" : "fast"
    }

    var dictionary: [String: Any] {
        var result: [String: Any] = [
            "fps": fps,
            "recognitionLevel": levelName
        ]
        if let displayID {
            result["displayID"] = displayID
        }
        if let roi {
            result["roi"] = roi.dictionary
        }
        if let scale {
            result["scale"] = scale
        }
        return result
    }
}

private struct CLIOptions {
    var configuration = CaptureConfiguration.default
    var fixturePath: String?
    var selfTest = false
    var autoStart = false

    static func parse(arguments: [String]) throws -> CLIOptions {
        var options = CLIOptions()
        var flatROI: [String: Double] = [:]
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--display-id", "--displayID", "--displayId":
                index += 1
                guard index < arguments.count, let displayID = UInt32(arguments[index]) else {
                    throw HelperError.invalidArgument("\(argument) requires an unsigned display ID.")
                }
                options.configuration.displayID = displayID
                options.autoStart = true
            case "--roi":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.invalidArgument("--roi requires x,y,width,height.")
                }
                options.configuration.roi = try parseCLIROI(arguments[index], units: .points)
                options.autoStart = true
            case "--roi-pixels", "--roiPixels":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.invalidArgument("\(argument) requires x,y,width,height.")
                }
                options.configuration.roi = try parseCLIROI(arguments[index], units: .pixels)
                options.autoStart = true
            case "--x", "--y", "--width", "--height":
                index += 1
                guard index < arguments.count, let value = Double(arguments[index]), value.isFinite else {
                    throw HelperError.invalidArgument("\(argument) requires a finite number.")
                }
                flatROI[String(argument.dropFirst(2))] = value
                options.autoStart = true
            case "--scale", "--retina-scale", "--retinaScale":
                index += 1
                guard index < arguments.count, let scale = Double(arguments[index]), scale > 0, scale <= 16 else {
                    throw HelperError.invalidArgument("\(argument) requires a scale between 0 and 16.")
                }
                options.configuration.scale = scale
                options.autoStart = true
            case "--fps":
                index += 1
                guard index < arguments.count, let fps = Double(arguments[index]), fps.isFinite else {
                    throw HelperError.invalidArgument("--fps requires a number.")
                }
                options.configuration.fps = clampFPS(fps)
                options.autoStart = true
            case "--accurate":
                options.configuration.recognitionLevel = .accurate
                options.autoStart = true
            case "--fast":
                options.configuration.recognitionLevel = .fast
                options.autoStart = true
            case "--start":
                options.autoStart = true
            case "--fixture":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.invalidArgument("--fixture requires an image path.")
                }
                options.fixturePath = arguments[index]
            case "--self-test", "--selftest":
                options.selfTest = true
            case "--help", "-h":
                printHelpAndExit()
            default:
                throw HelperError.invalidArgument("Unknown argument: \(argument)")
            }
            index += 1
        }
        if options.fixturePath != nil && options.selfTest {
            throw HelperError.invalidArgument("--fixture and --self-test cannot be used together.")
        }
        if !flatROI.isEmpty {
            let keys = ["x", "y", "width", "height"]
            guard keys.allSatisfy({ flatROI[$0] != nil }) else {
                throw HelperError.invalidROI("--x, --y, --width and --height must be supplied together.")
            }
            guard options.configuration.roi == nil else {
                throw HelperError.invalidROI("Use either --roi or --x/--y/--width/--height, not both.")
            }
            options.configuration.roi = try ROI.makeForCLI(
                x: flatROI["x"]!,
                y: flatROI["y"]!,
                width: flatROI["width"]!,
                height: flatROI["height"]!,
                units: .points
            )
        }
        return options
    }

    private static func parseCLIROI(_ value: String, units: ROIUnits) throws -> ROI {
        let values = value.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard values.count == 4, let x = Double(values[0]), let y = Double(values[1]),
              let width = Double(values[2]), let height = Double(values[3]) else {
            throw HelperError.invalidROI("ROI must be x,y,width,height; received \(value).")
        }
        return try ROI.makeForCLI(x: x, y: y, width: width, height: height, units: units)
    }
}

private extension ROI {
    static func makeForCLI(x: Double, y: Double, width: Double, height: Double, units: ROIUnits) throws -> ROI {
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite, width > 0, height > 0 else {
            throw HelperError.invalidROI("ROI x/y/width/height must be finite and width/height must be positive.")
        }
        return ROI(x: x, y: y, width: width, height: height, units: units, scale: nil)
    }
}

private func number(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let string = value as? String { return Double(string.trimmingCharacters(in: .whitespacesAndNewlines)) }
    return nil
}

private func clampFPS(_ value: Double) -> Double {
    // The helper intentionally keeps the capture cadence in the product's
    // intended 5–8 fps range, even if a caller sends a surprising value.
    min(8, max(5, value))
}

private func inferredDisplayScale(pixelWidth: Double, pixelHeight: Double, logicalWidth: Double, logicalHeight: Double) -> Double {
    guard pixelWidth.isFinite, pixelHeight.isFinite,
          logicalWidth.isFinite, logicalHeight.isFinite,
          pixelWidth > 0, pixelHeight > 0,
          logicalWidth > 0, logicalHeight > 0 else {
        return 1
    }
    // SCDisplay.frame is expressed in logical points. SCDisplay.width/height
    // are not a reliable pixel source across SDK versions, so use CoreGraphics
    // display pixel dimensions for the Retina conversion instead.
    return max(1, pixelWidth / logicalWidth, pixelHeight / logicalHeight)
}

private func smallTextOutputScale(pixelWidth: Int, pixelHeight: Int) -> Double {
    guard pixelWidth > 0, pixelHeight > 0 else { return 1 }
    // Upscaling compact ROIs materially improves Vision's recognition of
    // degree/prime glyphs. Keep the workload bounded for large selections.
    let width = Double(pixelWidth)
    let height = Double(pixelHeight)
    let areaScale = sqrt(3_000_000 / (width * height))
    let dimensionScale = 4096 / max(width, height)
    return max(1, min(1.5, areaScale, dimensionScale))
}

private func printHelpAndExit() -> Never {
    let help = """
    LocWarp OCR helper \(helperVersion)

    Usage:
      locwarp-ocr-helper [--display-id ID] [--roi x,y,w,h] [--fps 5..8] [--start]
      locwarp-ocr-helper --fixture /path/to/image.png [--accurate]
      locwarp-ocr-helper --self-test

    The running process accepts newline-delimited JSON on stdin:
      {"command":"start","displayID":123,"roi":{"x":0,"y":0,"width":600,"height":300,"units":"points"}}
      {"command":"stop"}
      {"command":"status"}
      {"command":"shutdown"}

    ROI coordinates are local to the selected display. Use units "pixels" for
    a pixel ROI; points are automatically converted using the display's Retina
    scale. Captured frames stay in memory and are not written to disk.
    """
    FileHandle.standardError.write(Data(help.utf8))
    Foundation.exit(0)
}

private struct OCRCandidate {
    let latitude: Double
    let longitude: Double
    let text: String
    let confidence: Float
    let boundingBox: CGRect

    var dictionary: [String: Any] {
        [
            "latitude": latitude,
            "longitude": longitude,
            "text": text,
            "confidence": Double(confidence),
            "boundingBox": [
                Double(boundingBox.origin.x),
                Double(boundingBox.origin.y),
                Double(boundingBox.size.width),
                Double(boundingBox.size.height)
            ]
        ]
    }
}

private struct OCRResult {
    let text: String
    let texts: [OCRTextLine]
    let candidates: [OCRCandidate]
}

// ScreenCaptureKit can deliver frames faster than Vision can recognize them.
// This mailbox deliberately keeps at most one waiting value. submit() is
// constant-time and returns whether the caller needs to start the single
// consumer task; the consumer remains marked busy until it observes an empty
// mailbox. The lock protects both the value and the busy transition so a frame
// arriving at the worker's boundary cannot strand a pending OCR.
private final class LatestValueMailbox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: Value?
    private var processing = false
    private var droppedCountValue = 0

    @discardableResult
    func submit(_ value: Value) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if latest != nil { droppedCountValue += 1 }
        latest = value
        guard !processing else { return false }
        processing = true
        return true
    }

    func take() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        guard let latest else {
            processing = false
            return nil
        }
        self.latest = nil
        return latest
    }

    func discardPending(resetDroppedCount: Bool = false) {
        lock.lock()
        let discarded = latest
        latest = nil
        if resetDroppedCount { droppedCountValue = 0 }
        lock.unlock()
        // Keep the replaced value alive until after the lock is released. A
        // CVPixelBuffer normally has no callback into this object on release,
        // but avoiding deallocation while holding the mailbox lock keeps that
        // assumption out of the synchronization contract.
        withExtendedLifetime(discarded) {}
    }

    var droppedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return droppedCountValue
    }

    var hasPending: Bool {
        lock.lock()
        defer { lock.unlock() }
        return latest != nil
    }

    var isProcessing: Bool {
        lock.lock()
        defer { lock.unlock() }
        return processing
    }
}

private struct PendingOCRFrame {
    let pixelBuffer: CVPixelBuffer
    let generation: UInt64
    let frameNumber: Int
    let recognitionLevel: VNRequestTextRecognitionLevel
}

private func latestValueMailboxSelfTest() -> Bool {
    let mailbox = LatestValueMailbox<Int>()
    guard mailbox.submit(1) else { return false }
    guard !mailbox.submit(2), !mailbox.submit(3) else { return false }
    guard mailbox.droppedCount == 2 else { return false }
    guard mailbox.take() == 3 else { return false }
    guard mailbox.take() == nil, !mailbox.isProcessing else { return false }
    guard mailbox.submit(4) else { return false }
    mailbox.discardPending(resetDroppedCount: true)
    guard mailbox.take() == nil && mailbox.droppedCount == 0 else { return false }

    // Model the important boundary where OCR already took the current frame,
    // then a newer capture arrives while the worker is still marked busy.
    let duringOCR = LatestValueMailbox<Int>()
    guard duringOCR.submit(10), duringOCR.take() == 10 else { return false }
    guard !duringOCR.submit(11), duringOCR.take() == 11 else { return false }
    return duringOCR.take() == nil && !duringOCR.isProcessing
}

private struct OCRTextLine {
    let text: String
    let confidence: Float
    let boundingBox: CGRect

    var dictionary: [String: Any] {
        [
            "text": text,
            "confidence": Double(confidence),
            "boundingBox": [
                Double(boundingBox.origin.x),
                Double(boundingBox.origin.y),
                Double(boundingBox.size.width),
                Double(boundingBox.size.height)
            ]
        ]
    }
}

private enum CoordinateParser {
    // Directional formats require explicit latitude/longitude hemispheres so
    // DMS/DM values cannot be assembled from unrelated numbers on the screen.
    // Plain decimal coordinates retain the existing comma requirement.
    private static let dmsRegex = try! NSRegularExpression(
        pattern: #"(?<![0-9.])([+-]?\d{1,2})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([NS])(?:\s*[,;]\s*|\s+)([+-]?\d{1,3})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([EW])(?![A-Z])"#,
        options: [.caseInsensitive]
    )
    private static let dmRegex = try! NSRegularExpression(
        pattern: #"(?<![0-9.])([+-]?\d{1,2})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'\s*([NS])(?:\s*[,;]\s*|\s+)([+-]?\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'\s*([EW])(?![A-Z])"#,
        options: [.caseInsensitive]
    )
    private static let directionalDecimalRegex = try! NSRegularExpression(
        pattern: #"(?<![0-9.])([+-]?(?:\d+\.\d+|\.\d+))\s*°?\s*([NS])(?:\s*[,;]\s*|\s+)([+-]?(?:\d+\.\d+|\.\d+))\s*°?\s*([EW])(?![A-Z])"#,
        options: [.caseInsensitive]
    )
    private static let decimalRegex = try! NSRegularExpression(
        pattern: "(?<![0-9.])([+-]?(?:\\d+\\.\\d+|\\.\\d+))\\s*[,，]\\s*([+-]?(?:\\d+\\.\\d+|\\.\\d+))(?![0-9.])",
        options: []
    )

    static func candidates(in text: String, confidence: Float = 0, boundingBox: CGRect = .zero) -> [OCRCandidate] {
        let normalized = text
            .applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text
        let canonical = normalized
            .replacingOccurrences(of: "−", with: "-")
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "，", with: ",")
            .replacingOccurrences(of: "；", with: ";")
            .replacingOccurrences(of: "º", with: "°")
            .replacingOccurrences(of: "˚", with: "°")
            .replacingOccurrences(of: "′", with: "'")
            .replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "‘", with: "'")
            .replacingOccurrences(of: "″", with: "\"")
            .replacingOccurrences(of: "“", with: "\"")
            .replacingOccurrences(of: "”", with: "\"")
        let range = NSRange(canonical.startIndex..<canonical.endIndex, in: canonical)
        var result: [OCRCandidate] = []
        var seen = Set<String>()

        func append(_ coordinate: (latitude: Double, longitude: Double)?) {
            guard let coordinate else { return }
            let latitude = coordinate.latitude
            let longitude = coordinate.longitude
            let key = String(format: "%.7f,%.7f", latitude, longitude)
            guard seen.insert(key).inserted else { return }
            result.append(OCRCandidate(
                latitude: latitude,
                longitude: longitude,
                text: text,
                confidence: confidence,
                boundingBox: boundingBox
            ))
        }

        dmsRegex.enumerateMatches(in: canonical, options: [], range: range) { match, _, _ in
            guard let match else { return }
            append(directionalCoordinate(
                in: canonical,
                match: match,
                latitude: (1, 2, 3, 4),
                longitude: (5, 6, 7, 8)
            ))
        }
        dmRegex.enumerateMatches(in: canonical, options: [], range: range) { match, _, _ in
            guard let match else { return }
            append(directionalCoordinate(
                in: canonical,
                match: match,
                latitude: (1, 2, nil, 3),
                longitude: (4, 5, nil, 6)
            ))
        }
        directionalDecimalRegex.enumerateMatches(in: canonical, options: [], range: range) { match, _, _ in
            guard let match else { return }
            append(directionalCoordinate(
                in: canonical,
                match: match,
                latitude: (1, nil, nil, 2),
                longitude: (3, nil, nil, 4)
            ))
        }
        decimalRegex.enumerateMatches(in: canonical, options: [], range: range) { match, _, _ in
            guard let match,
                  let latitude = number(in: canonical, match: match, group: 1),
                  let longitude = number(in: canonical, match: match, group: 2),
                  latitude.isFinite, longitude.isFinite,
                  abs(latitude) <= 90, abs(longitude) <= 180 else { return }
            append((latitude, longitude))
        }
        return result
    }

    private static func capture(in text: String, match: NSTextCheckingResult, group: Int) -> String? {
        let captureRange = match.range(at: group)
        guard captureRange.location != NSNotFound,
              let range = Range(captureRange, in: text) else { return nil }
        return String(text[range])
    }

    private static func number(in text: String, match: NSTextCheckingResult, group: Int) -> Double? {
        guard let token = capture(in: text, match: match, group: group),
              let value = Double(token), value.isFinite else { return nil }
        return value
    }

    private static func directionalValue(
        degreeToken: String,
        minutes: Double?,
        seconds: Double?,
        hemisphere: String,
        maximum: Double
    ) -> Double? {
        guard let degrees = Double(degreeToken), degrees.isFinite else { return nil }
        let minutesValue = minutes ?? 0
        let secondsValue = seconds ?? 0
        guard minutesValue.isFinite, secondsValue.isFinite,
              minutesValue >= 0, minutesValue < 60,
              secondsValue >= 0, secondsValue < 60 else { return nil }

        let direction = hemisphere.uppercased()
        let isNegativeDirection = direction == "S" || direction == "W"
        let explicitlyNegative = degreeToken.hasPrefix("-")
        let explicitlyPositive = degreeToken.hasPrefix("+")
        if explicitlyNegative && !isNegativeDirection { return nil }
        if explicitlyPositive && isNegativeDirection { return nil }

        let magnitude = abs(degrees) + minutesValue / 60 + secondsValue / 3600
        guard magnitude <= maximum else { return nil }
        return isNegativeDirection ? -magnitude : magnitude
    }

    private static func directionalCoordinate(
        in text: String,
        match: NSTextCheckingResult,
        latitude: (degrees: Int, minutes: Int?, seconds: Int?, hemisphere: Int),
        longitude: (degrees: Int, minutes: Int?, seconds: Int?, hemisphere: Int)
    ) -> (latitude: Double, longitude: Double)? {
        guard let latitudeDegrees = capture(in: text, match: match, group: latitude.degrees),
              let latitudeHemisphere = capture(in: text, match: match, group: latitude.hemisphere),
              let longitudeDegrees = capture(in: text, match: match, group: longitude.degrees),
              let longitudeHemisphere = capture(in: text, match: match, group: longitude.hemisphere) else {
            return nil
        }
        let latitudeMinutes = latitude.minutes.flatMap { number(in: text, match: match, group: $0) }
        let latitudeSeconds = latitude.seconds.flatMap { number(in: text, match: match, group: $0) }
        let longitudeMinutes = longitude.minutes.flatMap { number(in: text, match: match, group: $0) }
        let longitudeSeconds = longitude.seconds.flatMap { number(in: text, match: match, group: $0) }
        if latitude.minutes != nil && latitudeMinutes == nil { return nil }
        if latitude.seconds != nil && latitudeSeconds == nil { return nil }
        if longitude.minutes != nil && longitudeMinutes == nil { return nil }
        if longitude.seconds != nil && longitudeSeconds == nil { return nil }

        guard let latitudeValue = directionalValue(
                  degreeToken: latitudeDegrees,
                  minutes: latitudeMinutes,
                  seconds: latitudeSeconds,
                  hemisphere: latitudeHemisphere,
                  maximum: 90
              ),
              let longitudeValue = directionalValue(
                  degreeToken: longitudeDegrees,
                  minutes: longitudeMinutes,
                  seconds: longitudeSeconds,
                  hemisphere: longitudeHemisphere,
                  maximum: 180
              ) else { return nil }
        return (latitudeValue, longitudeValue)
    }

    static func selfTest() -> Bool {
        let cases: [(String, Double, Double)] = [
            ("28.647615,77.189494", 28.647615, 77.189494),
            ("41.8243328138, -71.4662015811", 41.8243328138, -71.4662015811),
            ("49.346681，9.129642", 49.346681, 9.129642),
            ("39°00'19.7\"N 84°36'21.9\"W", 39.0054722222, -84.6060833333),
            ("39º00′19.7″N，84˚36′21.9″W", 39.0054722222, -84.6060833333),
            ("39°0.3283′N, 84°36.365′W", 39.0054716667, -84.6060833333),
            ("39.005472°N, 84.606083°W", 39.005472, -84.606083)
        ]
        for (text, expectedLatitude, expectedLongitude) in cases {
            guard let candidate = candidates(in: text).first,
                  abs(candidate.latitude - expectedLatitude) < 0.0000001,
                  abs(candidate.longitude - expectedLongitude) < 0.0000001 else {
                return false
            }
        }
        return candidates(in: "128.0, 190.0").isEmpty
            && candidates(in: "postal 12345").isEmpty
            && candidates(in: "25,121").isEmpty
            && candidates(in: "39°60'0\"N 84°0'0\"W").isEmpty
            && candidates(in: "39°0'60\"N 84°0'0\"W").isEmpty
            && candidates(in: "39°0'0\"E 84°0'0\"N").isEmpty
            && candidates(in: "-39°0'0\"N 84°0'0\"W").isEmpty
            && candidates(in: "+39°0'0\"S 84°0'0\"W").isEmpty
    }
}

private func scaleSelfTest() -> Bool {
    abs(inferredDisplayScale(pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080) - 1) < 0.0001
        && abs(inferredDisplayScale(pixelWidth: 3024, pixelHeight: 1964, logicalWidth: 1512, logicalHeight: 982) - 2) < 0.0001
        && inferredDisplayScale(pixelWidth: 0, pixelHeight: 0, logicalWidth: 1512, logicalHeight: 982) == 1
        && abs(smallTextOutputScale(pixelWidth: 1200, pixelHeight: 600) - 1.5) < 0.0001
        && smallTextOutputScale(pixelWidth: 2400, pixelHeight: 1200) > 1
        && smallTextOutputScale(pixelWidth: 3000, pixelHeight: 2000) == 1
}

private enum OCRRecognizer {
    static func configurationSelfTest() -> Bool {
        let request = makeRequest(level: .accurate)
        return request.recognitionLevel == .accurate
            && abs(request.minimumTextHeight - 0.005) < 0.000001
            && request.usesLanguageCorrection == false
    }

    static func recognize(pixelBuffer: CVPixelBuffer, level: VNRequestTextRecognitionLevel) throws -> OCRResult {
        let request = makeRequest(level: level)
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
        try handler.perform([request])
        return result(from: request.results ?? [])
    }

    static func recognize(image: CGImage, level: VNRequestTextRecognitionLevel) throws -> OCRResult {
        let request = makeRequest(level: level)
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        try handler.perform([request])
        return result(from: request.results ?? [])
    }

    private static func makeRequest(level: VNRequestTextRecognitionLevel) -> VNRecognizeTextRequest {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = level
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = false
        // The selected ROI is already cropped and captured at Retina scale.
        // Accept glyphs down to 0.5% of the ROI height so compact coordinate
        // rows remain visible without weakening confidence/two-frame gates.
        request.minimumTextHeight = 0.005
        return request
    }

    private static func result(from observations: [VNRecognizedTextObservation]) -> OCRResult {
        var lines: [String] = []
        var texts: [OCRTextLine] = []
        var candidates: [OCRCandidate] = []
        for observation in observations {
            guard let recognized = observation.topCandidates(1).first else { continue }
            let text = recognized.string
            lines.append(text)
            texts.append(OCRTextLine(
                text: text,
                confidence: recognized.confidence,
                boundingBox: observation.boundingBox
            ))
            candidates.append(contentsOf: CoordinateParser.candidates(
                in: text,
                confidence: recognized.confidence,
                boundingBox: observation.boundingBox
            ))
        }
        return OCRResult(text: lines.joined(separator: "\n"), texts: texts, candidates: candidates)
    }
}

@available(macOS 12.3, *)
private final class CaptureController: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let emitter: JSONEmitter
    private let sampleQueue = DispatchQueue(label: "tw.xuan.locwarp.ocr.sample", qos: .userInitiated)
    private let ocrQueue = DispatchQueue(label: "tw.xuan.locwarp.ocr.vision", qos: .userInitiated)
    private let frameMailbox = LatestValueMailbox<PendingOCRFrame>()
    private let stateLock = NSLock()
    private var stream: SCStream?
    private var state = "idle"
    private var configuration = CaptureConfiguration.default
    private var selectedDisplayID: UInt32?
    private var frameNumber = 0
    private var processedFrameCount = 0
    // A start/stop cycle owns one token. Incrementing it on either operation
    // makes every continuation from an older async start stale by definition.
    private var generation: UInt64 = 0
    private var streamGeneration: UInt64?
    private var stopRequested = false
    private var shutdownAfterStop = false

    init(emitter: JSONEmitter) {
        self.emitter = emitter
        super.init()
    }

    func start(_ requestedConfiguration: CaptureConfiguration) {
        stateLock.lock()
        guard state == "idle" else {
            let currentState = state
            stateLock.unlock()
            emitter.emit([
                "event": "error",
                "code": "already_running",
                "message": "Capture is already \(currentState)."
            ])
            return
        }
        state = "starting"
        generation &+= 1
        let startGeneration = generation
        streamGeneration = nil
        configuration = requestedConfiguration
        frameNumber = 0
        processedFrameCount = 0
        frameMailbox.discardPending(resetDroppedCount: true)
        stopRequested = false
        stateLock.unlock()

        emitter.emit([
            "event": "permission",
            "status": "requesting",
            "state": "requesting",
            "message": "Requesting Screen Recording access for the selected display."
        ])

        Task { [weak self] in
            guard let self else { return }
            do {
                guard self.isCurrentStarting(startGeneration) else { return }
                let shareableContent: SCShareableContent
                do {
                    shareableContent = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                } catch {
                    if self.isCurrentStarting(startGeneration) {
                        DispatchQueue.main.async {
                            guard self.isCurrentStarting(startGeneration) else { return }
                            self.emitter.emit([
                                "event": "permission",
                                "status": "denied",
                                "state": "denied",
                                "message": error.localizedDescription
                            ])
                        }
                    }
                    throw HelperError.captureUnavailable(error.localizedDescription)
                }
                guard self.isCurrentStarting(startGeneration) else { return }
                DispatchQueue.main.async {
                    guard self.isCurrentStarting(startGeneration) else { return }
                    self.emitter.emit([
                        "event": "permission",
                        "status": "granted",
                        "state": "granted"
                    ])
                }
                guard self.isCurrentStarting(startGeneration) else { return }
                guard let display = try self.selectDisplay(from: shareableContent.displays, requestedID: requestedConfiguration.displayID) else {
                    throw HelperError.noDisplays
                }
                guard self.isCurrentStarting(startGeneration) else { return }
                let resolved = try self.resolveCapture(display: display, requested: requestedConfiguration)
                // Exclude the LocWarp app itself so the capture ROI does not
                // repeatedly OCR the helper status overlay or its own labels.
                let ownApplications = shareableContent.applications.filter {
                    $0.bundleIdentifier == "com.locwarp.app"
                }
                let filter = SCContentFilter(
                    display: display,
                    excludingApplications: ownApplications,
                    exceptingWindows: []
                )
                let streamConfiguration = SCStreamConfiguration()
                streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(resolved.configuration.fps.rounded()))
                // Vision runs off the capture callback and the mailbox keeps
                // only the newest waiting frame. A shallow ScreenCaptureKit
                // queue prevents old buffers from adding latency before they
                // reach that mailbox, while still allowing one callback to be
                // in flight during an OCR pass.
                streamConfiguration.queueDepth = 2
                streamConfiguration.showsCursor = false
                streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
                streamConfiguration.width = resolved.pixelWidth
                streamConfiguration.height = resolved.pixelHeight
                if let sourceRect = resolved.sourceRect {
                    streamConfiguration.sourceRect = sourceRect
                }

                let newStream = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)
                try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.sampleQueue)
                guard self.isCurrentStarting(startGeneration) else {
                    try? await newStream.stopCapture()
                    return
                }
                try await newStream.startCapture()
                guard self.isCurrentStarting(startGeneration) else {
                    try? await newStream.stopCapture()
                    return
                }

                DispatchQueue.main.async {
                    self.stateLock.lock()
                    guard self.generation == startGeneration,
                          self.state == "starting",
                          !self.stopRequested else {
                        self.stateLock.unlock()
                        Task {
                            try? await newStream.stopCapture()
                        }
                        return
                    }
                    self.stream = newStream
                    self.streamGeneration = startGeneration
                    self.selectedDisplayID = display.displayID
                    self.configuration = resolved.configuration
                    self.state = "running"
                    self.stateLock.unlock()
                    self.emitter.emit([
                        "event": "started",
                        "displayID": display.displayID,
                        "displayFrame": [
                            Double(display.frame.origin.x),
                            Double(display.frame.origin.y),
                            Double(display.frame.width),
                            Double(display.frame.height)
                        ],
                        "roi": resolved.outputROI,
                        "scale": resolved.scale,
                        "fps": resolved.configuration.fps,
                        "recognitionLevel": resolved.configuration.levelName
                    ])
                }
            } catch {
                DispatchQueue.main.async {
                    self.stateLock.lock()
                    guard self.generation == startGeneration,
                          self.state == "starting",
                          !self.stopRequested else {
                        self.stateLock.unlock()
                        return
                    }
                    self.state = "idle"
                    self.stream = nil
                    self.streamGeneration = nil
                    self.stateLock.unlock()
                    self.emitError(error, operation: "start")
                }
            }
        }
    }

    func stop(shutdown: Bool = false) {
        stateLock.lock()
        if shutdown { shutdownAfterStop = true }
        let currentState = state
        if currentState == "idle" {
            frameMailbox.discardPending()
            let shouldShutdown = shutdownAfterStop
            shutdownAfterStop = false
            stateLock.unlock()
            emitter.emit(["event": "stopped"])
            if shouldShutdown { stopMainRunLoop() }
            return
        }
        if currentState == "stopping" {
            frameMailbox.discardPending()
            stateLock.unlock()
            return
        }
        state = "stopping"
        generation &+= 1
        stopRequested = true
        frameMailbox.discardPending()
        let activeStream = stream
        stateLock.unlock()

        guard let activeStream else {
            finishStop()
            return
        }
        Task {
            do {
                try await activeStream.stopCapture()
            } catch {
                // A stream that has already stopped reports an error here on
                // some macOS versions. The stop operation remains idempotent.
                self.emitter.emit([
                    "event": "warning",
                    "code": "stop_capture",
                    "message": error.localizedDescription
                ])
            }
            DispatchQueue.main.async {
                self.finishStop()
            }
        }
    }

    func status() {
        stateLock.lock()
        let currentState = state
        let currentConfiguration = configuration.dictionary
        let currentDisplayID = selectedDisplayID
        let captureTelemetry = captureTelemetryLocked()
        stateLock.unlock()
        var output: [String: Any] = [
            "event": "status",
            "state": currentState,
            "configuration": currentConfiguration,
            "capture": captureTelemetry
        ]
        if let currentDisplayID { output["displayID"] = currentDisplayID }
        emitter.emit(output)
    }

    func shutdown() {
        stop(shutdown: true)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        stateLock.lock()
        guard state == "running",
              !stopRequested,
              streamGeneration == generation,
              self.stream === stream else {
            stateLock.unlock()
            return
        }
        let pendingFrame = PendingOCRFrame(
            pixelBuffer: pixelBuffer,
            generation: generation,
            frameNumber: frameNumber + 1,
            recognitionLevel: configuration.recognitionLevel
        )
        frameNumber += 1
        let shouldScheduleOCR = frameMailbox.submit(pendingFrame)
        stateLock.unlock()

        guard shouldScheduleOCR else { return }
        ocrQueue.async { [weak self] in
            self?.processPendingFrames()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            self.stateLock.lock()
            // The explicit stop task owns the stopping -> idle transition.
            // A delegate error can arrive during that transition; handling it
            // here would race finishStop() and emit duplicate lifecycle events.
            guard self.state != "stopping" else {
                self.stateLock.unlock()
                return
            }
            let isActiveStream = self.stream === stream
                && self.streamGeneration == self.generation
            guard isActiveStream else {
                self.stateLock.unlock()
                return
            }
            let shouldReport = !self.stopRequested
            self.state = "idle"
            self.stream = nil
            self.streamGeneration = nil
            self.stopRequested = false
            self.frameMailbox.discardPending()
            self.stateLock.unlock()
            if shouldReport {
                self.emitError(error, operation: "capture")
            }
        }
    }

    private func selectDisplay(from displays: [SCDisplay], requestedID: UInt32?) throws -> SCDisplay? {
        if let requestedID {
            guard let display = displays.first(where: { $0.displayID == requestedID }) else {
                throw HelperError.displayNotFound(requestedID)
            }
            return display
        }
        if let mainScreen = NSScreen.main,
           let mainID = mainScreen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
           let display = displays.first(where: { $0.displayID == mainID.uint32Value }) {
            return display
        }
        return displays.first
    }

    private struct ResolvedCapture {
        let configuration: CaptureConfiguration
        let sourceRect: CGRect?
        let outputROI: [String: Any]
        let scale: Double
        let pixelWidth: Int
        let pixelHeight: Int
    }

    private func resolveCapture(display: SCDisplay, requested: CaptureConfiguration) throws -> ResolvedCapture {
        let displayFrameWidth = max(Double(display.frame.width), 1)
        let displayFrameHeight = max(Double(display.frame.height), 1)
        let displayPixelWidth = Double(CGDisplayPixelsWide(display.displayID))
        let displayPixelHeight = Double(CGDisplayPixelsHigh(display.displayID))
        let inferredScale = inferredDisplayScale(
            pixelWidth: displayPixelWidth,
            pixelHeight: displayPixelHeight,
            logicalWidth: displayFrameWidth,
            logicalHeight: displayFrameHeight
        )
        let requestedScale = requested.roi?.scale ?? requested.scale
        let scale = requestedScale ?? inferredScale
        let displayBounds = CGRect(x: 0, y: 0, width: displayFrameWidth, height: displayFrameHeight)

        var sourceRect: CGRect?
        var outputROI: [String: Any]
        if let roi = requested.roi {
            let roiScale = roi.scale ?? scale
            let localRect: CGRect
            switch roi.units {
            case .points:
                localRect = CGRect(x: roi.x, y: roi.y, width: roi.width, height: roi.height)
            case .pixels:
                localRect = CGRect(x: roi.x / roiScale, y: roi.y / roiScale, width: roi.width / roiScale, height: roi.height / roiScale)
            }
            let clipped = localRect.intersection(displayBounds)
            guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else {
                throw HelperError.invalidROI("ROI does not intersect the selected display.")
            }
            let nativePixelWidth = max(1, Int(ceil(clipped.width * roiScale)))
            let nativePixelHeight = max(1, Int(ceil(clipped.height * roiScale)))
            let textScale = smallTextOutputScale(
                pixelWidth: nativePixelWidth,
                pixelHeight: nativePixelHeight
            )
            sourceRect = clipped
            outputROI = [
                "x": Double(clipped.origin.x),
                "y": Double(clipped.origin.y),
                "width": Double(clipped.width),
                "height": Double(clipped.height),
                "units": "points",
                "requestedUnits": roi.units.rawValue,
                "scale": roiScale,
                "ocrScale": roiScale * textScale
            ]
            return ResolvedCapture(
                configuration: requested,
                sourceRect: sourceRect,
                outputROI: outputROI,
                scale: roiScale,
                pixelWidth: max(1, Int(ceil(Double(nativePixelWidth) * textScale))),
                pixelHeight: max(1, Int(ceil(Double(nativePixelHeight) * textScale)))
            )
        }

        outputROI = [
            "x": 0.0,
            "y": 0.0,
            "width": displayFrameWidth,
            "height": displayFrameHeight,
            "units": "points",
            "scale": scale
        ]
        return ResolvedCapture(
            configuration: requested,
            sourceRect: nil,
            outputROI: outputROI,
            scale: scale,
            pixelWidth: max(1, Int(ceil(displayFrameWidth * scale))),
            pixelHeight: max(1, Int(ceil(displayFrameHeight * scale)))
        )
    }

    private func finishStop() {
        stateLock.lock()
        state = "idle"
        stream = nil
        streamGeneration = nil
        stopRequested = false
        frameMailbox.discardPending()
        let shouldShutdown = shutdownAfterStop
        shutdownAfterStop = false
        stateLock.unlock()
        emitter.emit(["event": "stopped"])
        if shouldShutdown { stopMainRunLoop() }
    }

    private func processPendingFrames() {
        while let frame = frameMailbox.take() {
            guard beginOCR(for: frame) else { continue }

            autoreleasepool {
                do {
                    let result = try OCRRecognizer.recognize(
                        pixelBuffer: frame.pixelBuffer,
                        level: frame.recognitionLevel
                    )
                    DispatchQueue.main.async {
                        guard self.isCurrentRunning(frame.generation) else { return }
                        var output: [String: Any] = [
                            "event": "frame",
                            "frame": frame.frameNumber,
                            "text": result.text,
                            "texts": result.texts.map(\.dictionary),
                            "candidates": result.candidates.map(\.dictionary)
                        ]
                        self.stateLock.lock()
                        let telemetry = self.captureTelemetryLocked()
                        self.stateLock.unlock()
                        for (key, value) in telemetry { output[key] = value }
                        self.emitter.emit(output)
                    }
                } catch {
                    DispatchQueue.main.async {
                        guard self.isCurrentRunning(frame.generation) else { return }
                        self.emitError(error, operation: "ocr", frame: frame.frameNumber)
                    }
                }
            }
        }
    }

    private func beginOCR(for frame: PendingOCRFrame) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard generation == frame.generation,
              state == "running",
              !stopRequested,
              streamGeneration == frame.generation else {
            return false
        }
        processedFrameCount += 1
        return true
    }

    private func captureTelemetryLocked() -> [String: Any] {
        [
            "capturedFrameCount": frameNumber,
            "processedFrameCount": processedFrameCount,
            "captureDroppedCount": frameMailbox.droppedCount,
            "queuedFrameCount": frameMailbox.hasPending ? 1 : 0,
            "ocrInFlight": frameMailbox.isProcessing
        ]
    }

    private func emitError(_ error: Error, operation: String, frame: Int? = nil) {
        var output: [String: Any] = [
            "event": "error",
            "code": errorCode(for: error),
            "operation": operation,
            "message": error.localizedDescription
        ]
        if let frame { output["frame"] = frame }
        emitter.emit(output)
    }

    private func errorCode(for error: Error) -> String {
        if let helperError = error as? HelperError {
            switch helperError {
            case .displayNotFound: return "display_not_found"
            case .noDisplays: return "no_displays"
            case .invalidROI: return "invalid_roi"
            case .captureUnavailable: return "permission_denied"
            default: return "helper_error"
            }
        }
        let nsError = error as NSError
        if nsError.domain == "com.apple.ScreenCaptureKit" || nsError.domain.contains("ScreenCapture") {
            return "screen_capture_error"
        }
        return "capture_error"
    }

    private func stopMainRunLoop() {
        // dispatchMain() is used below instead of a RunLoop. Exiting only
        // after stopCapture() completes keeps the child process from being
        // torn down while ScreenCaptureKit still owns a frame buffer.
        Foundation.exit(0)
    }

    private func isCurrentStarting(_ token: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return generation == token && state == "starting" && !stopRequested
    }

    private func isCurrentRunning(_ token: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return generation == token && state == "running" && !stopRequested && streamGeneration == token
    }
}

private final class StandardInputReader {
    private let controller: CaptureController

    init(controller: CaptureController) {
        self.controller = controller
    }

    func start() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                DispatchQueue.main.async {
                    self.handle(trimmed)
                }
            }
            DispatchQueue.main.async {
                self.controller.shutdown()
            }
        }
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let command = object as? [String: Any] else {
            controller.emitCommandError("Input must be a JSON object on one line.")
            return
        }
        let name = (command["command"] as? String ?? command["action"] as? String ?? command["type"] as? String ?? "").lowercased()
        do {
            switch name {
            case "start", "begin":
                controller.start(try configuration(from: command))
            case "stop", "end":
                controller.stop()
            case "status", "state":
                controller.status()
            case "shutdown", "quit", "exit":
                controller.shutdown()
            default:
                throw HelperError.invalidCommand("Unknown command: \(name.isEmpty ? "missing command" : name)")
            }
        } catch {
            controller.emitCommandError(error.localizedDescription)
        }
    }

    private func configuration(from command: [String: Any]) throws -> CaptureConfiguration {
        var configuration = CaptureConfiguration.default
        if let displayID = command["displayID"] ?? command["displayId"] ?? command["display_id"],
           let value = number(displayID) {
            guard value >= 0, value <= Double(UInt32.max) else {
                throw HelperError.invalidArgument("displayID is outside the UInt32 range.")
            }
            configuration.displayID = UInt32(value)
        }
        if let roiValue = command["roi"] ?? command["ROI"] {
            configuration.roi = try ROI.parse(roiValue)
        } else {
            let flatKeys = ["x", "y", "width", "height"]
            let hasFlatROI = flatKeys.contains { command[$0] != nil }
            if hasFlatROI {
                guard flatKeys.allSatisfy({ command[$0] != nil }),
                      let x = number(command["x"]), let y = number(command["y"]),
                      let width = number(command["width"]), let height = number(command["height"]) else {
                    throw HelperError.invalidROI("Flat ROI commands require numeric x, y, width and height.")
                }
                let units = ROIUnits(rawValue: (command["units"] as? String ?? "points").lowercased()) ?? .points
                let roiScale = number(command["roiScale"] ?? command["roi_scale"])
                guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                      width > 0, height > 0 else {
                    throw HelperError.invalidROI("ROI x/y/width/height must be finite and width/height must be positive.")
                }
                configuration.roi = ROI(x: x, y: y, width: width, height: height, units: units, scale: roiScale)
            }
        }
        if let fps = number(command["fps"]) {
            guard fps.isFinite else { throw HelperError.invalidArgument("fps must be finite.") }
            configuration.fps = clampFPS(fps)
        }
        if let scale = number(command["scale"] ?? command["retinaScale"] ?? command["retina_scale"]) {
            guard scale.isFinite, scale > 0, scale <= 16 else {
                throw HelperError.invalidArgument("scale must be greater than 0 and no greater than 16.")
            }
            configuration.scale = scale
        }
        if let level = (command["recognitionLevel"] as? String ?? command["recognition_level"] as? String)?.lowercased() {
            switch level {
            case "accurate": configuration.recognitionLevel = .accurate
            case "fast": configuration.recognitionLevel = .fast
            default: throw HelperError.invalidArgument("recognitionLevel must be fast or accurate.")
            }
        }
        return configuration
    }
}

private extension CaptureController {
    func emitCommandError(_ message: String) {
        emitter.emit([
            "event": "error",
            "code": "invalid_command",
            "operation": "command",
            "message": message
        ])
    }
}

private func runFixture(path: String, level: VNRequestTextRecognitionLevel, emitter: JSONEmitter) throws {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw HelperError.imageLoadFailed("Unable to load image fixture: \(path)")
    }
    let result = try OCRRecognizer.recognize(image: image, level: level)
    emitter.emit([
        "event": "fixture",
        "path": url.path,
        "text": result.text,
        "texts": result.texts.map(\.dictionary),
        "candidates": result.candidates.map(\.dictionary)
    ])
}

@available(macOS 12.3, *)
private func runHelper() {
    let emitter = JSONEmitter()
    do {
        let options = try CLIOptions.parse(arguments: Array(CommandLine.arguments.dropFirst()))
        if options.selfTest {
            let passed = CoordinateParser.selfTest()
            let scalePassed = scaleSelfTest()
            let backpressurePassed = latestValueMailboxSelfTest()
            let smallTextPassed = OCRRecognizer.configurationSelfTest()
            emitter.emit([
                "event": "selfTest",
                "passed": passed && scalePassed && backpressurePassed && smallTextPassed,
                "parser": "dd-dm-dms-latitude-longitude",
                "scale": scalePassed,
                "backpressure": backpressurePassed,
                "smallText": smallTextPassed
            ])
            Foundation.exit(passed && scalePassed && backpressurePassed && smallTextPassed ? 0 : 1)
        }
        if let fixturePath = options.fixturePath {
            try runFixture(path: fixturePath, level: options.configuration.recognitionLevel, emitter: emitter)
            Foundation.exit(0)
        }

        emitter.emit([
            "event": "ready",
            "version": helperVersion,
            "state": "idle",
            "protocol": "ndjson-v1",
            "capabilities": [
                "screenCaptureKit",
                "visionOCR",
                "displayID",
                "roi",
                "retina",
                "coordinateFormats:dd-dm-dms"
            ],
            "fps": ["min": 5, "max": 8, "default": 6]
        ])

        let controller = CaptureController(emitter: emitter)
        let reader = StandardInputReader(controller: controller)
        reader.start()

        if options.autoStart {
            controller.start(options.configuration)
        }

        let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        signal(SIGINT, SIG_IGN)
        signalSource.setEventHandler {
            controller.shutdown()
        }
        signalSource.resume()

        let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        signal(SIGTERM, SIG_IGN)
        terminateSource.setEventHandler {
            controller.shutdown()
        }
        terminateSource.resume()

        dispatchMain()
    } catch {
        emitter.emit([
            "event": "error",
            "code": "startup_error",
            "operation": "startup",
            "message": error.localizedDescription
        ])
        Foundation.exit(2)
    }
}

if #available(macOS 12.3, *) {
    runHelper()
} else {
    let emitter = JSONEmitter()
    emitter.emit([
        "event": "error",
        "code": "unsupported_macos",
        "operation": "startup",
        "message": "Screen OCR requires macOS 12.3 or newer."
    ])
    Foundation.exit(2)
}
