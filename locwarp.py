#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
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


def api_request(method: str, path: str, payload: dict | None = None, query: dict | None = None):
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
            raw = resp.read().decode('utf-8')
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='ignore')
        raise SystemExit(f'HTTP {e.code}: {detail}')


def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


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
    return p


if __name__ == '__main__':
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
