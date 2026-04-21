#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import json
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


def api_request(method: str, path: str, payload: dict | None = None):
    url = f'{API_BASE}{path}'
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
    print(json.dumps(api_request('GET', '/api/device/list'), ensure_ascii=False, indent=2))


def cmd_teleport(args):
    payload = {'lat': args.lat, 'lng': args.lng}
    if args.udid:
        payload['udid'] = args.udid
    print(json.dumps(api_request('POST', '/api/location/teleport', payload), ensure_ascii=False, indent=2))


def cmd_restore(args):
    path = '/api/location/restore'
    if args.udid:
        path += f'?udid={args.udid}'
    print(json.dumps(api_request('POST', path), ensure_ascii=False, indent=2))


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

    tp = sub.add_parser('teleport', help='teleport device to lat/lng')
    tp.add_argument('lat', type=float)
    tp.add_argument('lng', type=float)
    tp.add_argument('--udid')
    tp.set_defaults(func=cmd_teleport)

    rs = sub.add_parser('restore', help='restore real location')
    rs.add_argument('--udid')
    rs.set_defaults(func=cmd_restore)
    return p


if __name__ == '__main__':
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
