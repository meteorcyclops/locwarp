"""Regression checks for the v0.2.196 backend dependency upgrade.

These checks intentionally stay hardware-free.  They verify that the runtime
has the userspace tunnel API that kx.18 uses and that the frozen backend keeps
the dynamic PyTCP modules plus the custom worker/DDI collection entries.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
from pathlib import Path
import unittest

from packaging.version import Version


REPO_ROOT = Path(__file__).resolve().parents[2]


class BackendDependencyUpgradeTests(unittest.TestCase):
    def test_pymobiledevice3_112_userspace_contract_is_available(self):
        pmd_version = Version(importlib.metadata.version("pymobiledevice3"))
        self.assertEqual(pmd_version, Version("11.2.4"))

        pytcp_version = Version(importlib.metadata.version("pmd-pytcp"))
        self.assertGreaterEqual(pytcp_version, Version("0.3.7"))
        self.assertIsNotNone(
            importlib.util.find_spec("pymobiledevice3.remote.userspace_tunnel")
        )
        self.assertIsNotNone(importlib.util.find_spec("pmd_pytcp"))

        from pymobiledevice3.remote.tunnel_service import (
            CoreDeviceTunnelProxy,
            create_core_device_tunnel_service_using_remotepairing,
        )
        from pymobiledevice3.remote.userspace_tunnel import (
            UserspaceDialPlane,
            UserspaceRsdTunnel,
        )

        self.assertTrue(callable(create_core_device_tunnel_service_using_remotepairing))
        self.assertTrue(callable(CoreDeviceTunnelProxy.create))
        self.assertTrue(callable(UserspaceDialPlane))
        self.assertTrue(callable(UserspaceRsdTunnel))

    def test_frozen_backend_keeps_pytcp_and_custom_collection_entries(self):
        spec = (REPO_ROOT / "backend" / "locwarp-backend.spec").read_text()
        self.assertIn("collect_all('pmd_pytcp')", spec)
        self.assertIn("*pytcp_hidden", spec)
        self.assertIn("*pytcp_binaries", spec)
        self.assertIn("*pytcp_datas", spec)
        # Existing DDI/apple-compress metadata and the kx.18 worker entrypoint
        # are part of the custom frozen-backend contract.
        self.assertIn("collect_all('apple_compress')", spec)
        self.assertIn("copy_metadata('apple-compress')", spec)
        self.assertIn("'core.wifi_worker'", spec)

    def test_macos_build_gate_matches_pinned_runtime(self):
        build_script = (REPO_ROOT / "scripts" / "build-macos.sh").read_text()
        self.assertIn('python3 -m venv --clear "$venv_dir"', build_script)
        self.assertIn('pmd_version != Version("11.2.4")', build_script)
        self.assertIn('"pymobiledevice3.remote.userspace_tunnel"', build_script)
        self.assertIn('"pmd_pytcp"', build_script)
        self.assertIn('Version("0.3.7")', build_script)


if __name__ == "__main__":
    unittest.main()
