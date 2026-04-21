#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / 'backend'
FRONTEND = ROOT / 'frontend'
BACKEND_PORT = 8777
FRONTEND_PORT = 5173
API_BASE = f'http://127.0.0.1:{BACKEND_PORT}'


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def wait_for_port(port: int, timeout: int = 60) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        if is_port_open(port):
            return True
        time.sleep(1)
    return False


def check_tool(name: str, hint: str) -> None:
    if not shutil.which(name):
        raise SystemExit(f'Missing {name}. Install first: {hint}')


def ensure_backend_deps() -> None:
    req = BACKEND / 'requirements.txt'
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', str(req)], check=True)


def ensure_frontend_deps() -> None:
    if not (FRONTEND / 'node_modules').exists():
        subprocess.run(['npm', 'install'], cwd=FRONTEND, check=True)


def api_request(method: str, path: str, payload: dict | None = None, query: dict | None = None, raw: bool = False):
    url = f'{API_BASE}{path}'
    if query:
        url += '?' + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, method=method.upper(), data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
            if raw:
                return body
            raw_text = body.decode('utf-8')
            return json.loads(raw_text) if raw_text else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='ignore')
        raise SystemExit(f'HTTP {e.code}: {detail}')


def api_upload(path: str, file_path: str, field_name: str = 'file'):
    boundary = '----LocWarpBoundary7MA4YWxkTrZu0gW'
    file_bytes = Path(file_path).read_bytes()
    filename = Path(file_path).name
    content_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    parts = []
    parts.append(f'--{boundary}\r\n'.encode())
    parts.append(f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode())
    parts.append(f'Content-Type: {content_type}\r\n\r\n'.encode())
    parts.append(file_bytes)
    parts.append(f'\r\n--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    req = urllib.request.Request(f'{API_BASE}{path}', method='POST', data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw_text = resp.read().decode('utf-8')
            return json.loads(raw_text) if raw_text else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='ignore')
        raise SystemExit(f'HTTP {e.code}: {detail}')


def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def parse_waypoints(items: list[str]):
    out = []
    for item in items:
        lat_s, lng_s = item.split(',', 1)
        out.append({'lat': float(lat_s), 'lng': float(lng_s)})
    return out


def cmd_serve(args):
    check_tool('node', 'https://nodejs.org/')
    check_tool('npm', 'https://nodejs.org/')
    ensure_backend_deps()
    if not args.backend_only:
        ensure_frontend_deps()

    backend_proc = None
    frontend_proc = None
    try:
        if not is_port_open(BACKEND_PORT):
            backend_proc = subprocess.Popen([sys.executable, 'main.py'], cwd=BACKEND)
            if not wait_for_port(BACKEND_PORT, 60):
                raise SystemExit('Backend failed to start on :8777')

        if not args.backend_only and not is_port_open(FRONTEND_PORT):
            frontend_proc = subprocess.Popen(['npx', 'vite', '--host', '--port', str(FRONTEND_PORT), '--strictPort'], cwd=FRONTEND)
            if not wait_for_port(FRONTEND_PORT, 60):
                raise SystemExit('Frontend failed to start on :5173')

        if args.open and not args.backend_only:
            webbrowser.open(f'http://127.0.0.1:{FRONTEND_PORT}')

        print(f'Backend:  http://127.0.0.1:{BACKEND_PORT}')
        if not args.backend_only:
            print(f'Frontend: http://127.0.0.1:{FRONTEND_PORT}')
        print(f'Docs:     http://127.0.0.1:{BACKEND_PORT}/docs')
        print('Press Ctrl+C to stop')
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for p in (frontend_proc, backend_proc):
            if p is not None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except Exception:
                    p.kill()


def cmd_open(_args):
    webbrowser.open(f'http://127.0.0.1:{FRONTEND_PORT}')


def cmd_device_list(_args):
    print_json(api_request('GET', '/api/device/list'))


def cmd_device_connect(args):
    print_json(api_request('POST', f'/api/device/{args.udid}/connect'))


def cmd_device_info(args):
    print_json(api_request('GET', f'/api/device/{args.udid}/info'))


def cmd_status(args):
    print_json(api_request('GET', '/api/location/status', query={'udid': args.udid}))


def cmd_teleport(args):
    payload = {'lat': args.lat, 'lng': args.lng}
    if args.udid:
        payload['udid'] = args.udid
    print_json(api_request('POST', '/api/location/teleport', payload))


def cmd_navigate(args):
    payload = {'lat': args.lat, 'lng': args.lng, 'mode': args.mode, 'straight_line': args.straight_line}
    if args.udid:
        payload['udid'] = args.udid
    if args.speed_kmh is not None:
        payload['speed_kmh'] = args.speed_kmh
    print_json(api_request('POST', '/api/location/navigate', payload))


def cmd_loop(args):
    payload = {
        'waypoints': parse_waypoints(args.waypoints),
        'mode': args.mode,
        'pause_enabled': not args.no_pause,
        'pause_min': args.pause_min,
        'pause_max': args.pause_max,
        'straight_line': args.straight_line,
        'lap_count': args.lap_count,
    }
    if args.udid:
        payload['udid'] = args.udid
    if args.speed_kmh is not None:
        payload['speed_kmh'] = args.speed_kmh
    print_json(api_request('POST', '/api/location/loop', payload))


def cmd_multistop(args):
    payload = {
        'waypoints': parse_waypoints(args.waypoints),
        'mode': args.mode,
        'stop_duration': args.stop_duration,
        'loop': args.loop,
        'pause_enabled': not args.no_pause,
        'pause_min': args.pause_min,
        'pause_max': args.pause_max,
        'straight_line': args.straight_line,
    }
    if args.udid:
        payload['udid'] = args.udid
    if args.speed_kmh is not None:
        payload['speed_kmh'] = args.speed_kmh
    print_json(api_request('POST', '/api/location/multistop', payload))


def cmd_randomwalk(args):
    payload = {
        'center': {'lat': args.lat, 'lng': args.lng},
        'radius_m': args.radius_m,
        'mode': args.mode,
        'pause_enabled': not args.no_pause,
        'pause_min': args.pause_min,
        'pause_max': args.pause_max,
        'straight_line': args.straight_line,
    }
    if args.udid:
        payload['udid'] = args.udid
    if args.speed_kmh is not None:
        payload['speed_kmh'] = args.speed_kmh
    print_json(api_request('POST', '/api/location/randomwalk', payload))


def cmd_stop(args):
    print_json(api_request('POST', '/api/location/stop', query={'udid': args.udid}))


def cmd_restore(args):
    print_json(api_request('POST', '/api/location/restore', query={'udid': args.udid}))


def cmd_pause(args):
    print_json(api_request('POST', '/api/location/pause', query={'udid': args.udid}))


def cmd_resume(args):
    print_json(api_request('POST', '/api/location/resume', query={'udid': args.udid}))


def cmd_search(args):
    print_json(api_request('GET', '/api/geocode/search', query={'q': args.query, 'limit': args.limit}))


def cmd_real_location(_args):
    print_json(api_request('GET', '/api/geocode/real-location'))


def cmd_recent_list(_args):
    print_json(api_request('GET', '/api/recent'))


def cmd_recent_add(args):
    print_json(api_request('POST', '/api/recent', payload={'lat': args.lat, 'lng': args.lng, 'kind': args.kind, 'name': args.name}))


def cmd_recent_clear(_args):
    print_json(api_request('DELETE', '/api/recent'))


def cmd_bookmark_list(_args):
    print_json(api_request('GET', '/api/bookmarks'))


def cmd_bookmark_add(args):
    print_json(api_request('POST', '/api/bookmarks', payload={
        'name': args.name,
        'lat': args.lat,
        'lng': args.lng,
        'address': args.address or '',
        'category_id': args.category_id,
        'country_code': args.country_code or '',
    }))


def cmd_bookmark_delete(args):
    print_json(api_request('DELETE', f'/api/bookmarks/{args.bookmark_id}'))


def cmd_category_list(_args):
    print_json(api_request('GET', '/api/bookmarks/categories'))


def cmd_category_add(args):
    print_json(api_request('POST', '/api/bookmarks/categories', payload={
        'name': args.name,
        'color': args.color,
    }))


def cmd_route_plan(args):
    print_json(api_request('POST', '/api/route/plan', payload={
        'start': {'lat': args.start_lat, 'lng': args.start_lng},
        'end': {'lat': args.end_lat, 'lng': args.end_lng},
        'profile': args.profile,
    }))


def cmd_route_list(_args):
    print_json(api_request('GET', '/api/route/saved'))


def cmd_route_save(args):
    print_json(api_request('POST', '/api/route/saved', payload={
        'name': args.name,
        'waypoints': parse_waypoints(args.waypoints),
        'profile': args.profile,
    }))


def cmd_route_rename(args):
    print_json(api_request('PATCH', f'/api/route/saved/{args.route_id}', payload={'name': args.name}))


def cmd_route_delete(args):
    print_json(api_request('DELETE', f'/api/route/saved/{args.route_id}'))


def cmd_route_export(args):
    data = api_request('GET', '/api/route/saved/export', raw=True)
    Path(args.output).write_bytes(data)
    print(args.output)


def cmd_route_import(args):
    data = json.loads(Path(args.input).read_text())
    print_json(api_request('POST', '/api/route/saved/import', payload=data))


def cmd_gpx_import(args):
    print_json(api_upload('/api/route/gpx/import', args.input))


def cmd_gpx_export(args):
    data = api_request('GET', f'/api/route/gpx/export/{args.route_id}', raw=True)
    Path(args.output).write_bytes(data)
    print(args.output)


def build_parser():
    p = argparse.ArgumentParser(prog='locwarp', description='LocWarp CLI launcher')
    sub = p.add_subparsers(dest='command', required=True)

    s = sub.add_parser('serve', help='start backend and optional frontend')
    s.add_argument('--backend-only', action='store_true')
    s.add_argument('--open', action='store_true')
    s.set_defaults(func=cmd_serve)

    o = sub.add_parser('open', help='open frontend in browser')
    o.set_defaults(func=cmd_open)

    dl = sub.add_parser('device-list', help='list discovered devices')
    dl.set_defaults(func=cmd_device_list)

    dc = sub.add_parser('device-connect', help='connect a device by udid')
    dc.add_argument('udid')
    dc.set_defaults(func=cmd_device_connect)

    di = sub.add_parser('device-info', help='show device info by udid')
    di.add_argument('udid')
    di.set_defaults(func=cmd_device_info)

    st = sub.add_parser('status', help='show simulation status')
    st.add_argument('--udid')
    st.set_defaults(func=cmd_status)

    tp = sub.add_parser('teleport', help='teleport device to lat/lng')
    tp.add_argument('lat', type=float)
    tp.add_argument('lng', type=float)
    tp.add_argument('--udid')
    tp.set_defaults(func=cmd_teleport)

    nav = sub.add_parser('navigate', help='navigate device to lat/lng')
    nav.add_argument('lat', type=float)
    nav.add_argument('lng', type=float)
    nav.add_argument('--mode', choices=['walking', 'running', 'driving'], default='walking')
    nav.add_argument('--speed-kmh', type=float)
    nav.add_argument('--straight-line', action='store_true')
    nav.add_argument('--udid')
    nav.set_defaults(func=cmd_navigate)

    lp = sub.add_parser('loop', help='start route loop with waypoint list')
    lp.add_argument('waypoints', nargs='+', help='lat,lng lat,lng ...')
    lp.add_argument('--mode', choices=['walking', 'running', 'driving'], default='walking')
    lp.add_argument('--speed-kmh', type=float)
    lp.add_argument('--lap-count', type=int)
    lp.add_argument('--no-pause', action='store_true')
    lp.add_argument('--pause-min', type=float, default=5.0)
    lp.add_argument('--pause-max', type=float, default=20.0)
    lp.add_argument('--straight-line', action='store_true')
    lp.add_argument('--udid')
    lp.set_defaults(func=cmd_loop)

    ms = sub.add_parser('multistop', help='start multi-stop route')
    ms.add_argument('waypoints', nargs='+', help='lat,lng lat,lng ...')
    ms.add_argument('--mode', choices=['walking', 'running', 'driving'], default='walking')
    ms.add_argument('--speed-kmh', type=float)
    ms.add_argument('--stop-duration', type=int, default=0)
    ms.add_argument('--loop', action='store_true')
    ms.add_argument('--no-pause', action='store_true')
    ms.add_argument('--pause-min', type=float, default=5.0)
    ms.add_argument('--pause-max', type=float, default=20.0)
    ms.add_argument('--straight-line', action='store_true')
    ms.add_argument('--udid')
    ms.set_defaults(func=cmd_multistop)

    rw = sub.add_parser('randomwalk', help='start random walk around center point')
    rw.add_argument('lat', type=float)
    rw.add_argument('lng', type=float)
    rw.add_argument('--radius-m', type=float, default=500.0)
    rw.add_argument('--mode', choices=['walking', 'running', 'driving'], default='walking')
    rw.add_argument('--speed-kmh', type=float)
    rw.add_argument('--no-pause', action='store_true')
    rw.add_argument('--pause-min', type=float, default=5.0)
    rw.add_argument('--pause-max', type=float, default=20.0)
    rw.add_argument('--straight-line', action='store_true')
    rw.add_argument('--udid')
    rw.set_defaults(func=cmd_randomwalk)

    sp = sub.add_parser('stop', help='stop movement without restore')
    sp.add_argument('--udid')
    sp.set_defaults(func=cmd_stop)

    rs = sub.add_parser('restore', help='restore real location')
    rs.add_argument('--udid')
    rs.set_defaults(func=cmd_restore)

    pa = sub.add_parser('pause', help='pause current movement')
    pa.add_argument('--udid')
    pa.set_defaults(func=cmd_pause)

    re = sub.add_parser('resume', help='resume current movement')
    re.add_argument('--udid')
    re.set_defaults(func=cmd_resume)

    se = sub.add_parser('search', help='search address/geocode')
    se.add_argument('query')
    se.add_argument('--limit', type=int, default=5)
    se.set_defaults(func=cmd_search)

    rl = sub.add_parser('real-location', help='get current public-IP real location')
    rl.set_defaults(func=cmd_real_location)

    rlist = sub.add_parser('recent-list', help='list recent places')
    rlist.set_defaults(func=cmd_recent_list)

    radd = sub.add_parser('recent-add', help='add a recent place entry')
    radd.add_argument('lat', type=float)
    radd.add_argument('lng', type=float)
    radd.add_argument('--kind', choices=['teleport', 'navigate', 'search', 'coord_teleport', 'coord_navigate'], default='teleport')
    radd.add_argument('--name')
    radd.set_defaults(func=cmd_recent_add)

    rclear = sub.add_parser('recent-clear', help='clear recent places')
    rclear.set_defaults(func=cmd_recent_clear)

    bl = sub.add_parser('bookmark-list', help='list bookmarks and categories')
    bl.set_defaults(func=cmd_bookmark_list)

    ba = sub.add_parser('bookmark-add', help='add bookmark')
    ba.add_argument('name')
    ba.add_argument('lat', type=float)
    ba.add_argument('lng', type=float)
    ba.add_argument('--address')
    ba.add_argument('--category-id', default='default')
    ba.add_argument('--country-code')
    ba.set_defaults(func=cmd_bookmark_add)

    bd = sub.add_parser('bookmark-delete', help='delete bookmark')
    bd.add_argument('bookmark_id')
    bd.set_defaults(func=cmd_bookmark_delete)

    cl = sub.add_parser('category-list', help='list bookmark categories')
    cl.set_defaults(func=cmd_category_list)

    ca = sub.add_parser('category-add', help='add bookmark category')
    ca.add_argument('name')
    ca.add_argument('--color', default='#6c8cff')
    ca.set_defaults(func=cmd_category_add)

    rp = sub.add_parser('route-plan', help='plan route between two coordinates')
    rp.add_argument('start_lat', type=float)
    rp.add_argument('start_lng', type=float)
    rp.add_argument('end_lat', type=float)
    rp.add_argument('end_lng', type=float)
    rp.add_argument('--profile', choices=['walking', 'running', 'driving', 'foot', 'car'], default='walking')
    rp.set_defaults(func=cmd_route_plan)

    rlst = sub.add_parser('route-list', help='list saved routes')
    rlst.set_defaults(func=cmd_route_list)

    rsv = sub.add_parser('route-save', help='save route from waypoint list')
    rsv.add_argument('name')
    rsv.add_argument('waypoints', nargs='+', help='lat,lng lat,lng ...')
    rsv.add_argument('--profile', default='walking')
    rsv.set_defaults(func=cmd_route_save)

    rrn = sub.add_parser('route-rename', help='rename saved route')
    rrn.add_argument('route_id')
    rrn.add_argument('name')
    rrn.set_defaults(func=cmd_route_rename)

    rdel = sub.add_parser('route-delete', help='delete saved route')
    rdel.add_argument('route_id')
    rdel.set_defaults(func=cmd_route_delete)

    rexp = sub.add_parser('route-export', help='export saved routes to json file')
    rexp.add_argument('output')
    rexp.set_defaults(func=cmd_route_export)

    rimp = sub.add_parser('route-import', help='import saved routes from json file')
    rimp.add_argument('input')
    rimp.set_defaults(func=cmd_route_import)

    gip = sub.add_parser('gpx-import', help='import gpx into saved routes')
    gip.add_argument('input')
    gip.set_defaults(func=cmd_gpx_import)

    gex = sub.add_parser('gpx-export', help='export saved route to gpx')
    gex.add_argument('route_id')
    gex.add_argument('output')
    gex.set_defaults(func=cmd_gpx_export)

    return p


if __name__ == '__main__':
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
