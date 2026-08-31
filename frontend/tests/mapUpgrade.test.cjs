const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(frontendDir, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(frontendDir, 'package-lock.json'), 'utf8'));
const mapSource = fs.readFileSync(path.join(frontendDir, 'src/components/MapView.tsx'), 'utf8');
const appSource = fs.readFileSync(path.join(frontendDir, 'src/App.tsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(frontendDir, 'electron/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(frontendDir, 'electron/preload.js'), 'utf8');

test('MapLibre 6, Supercluster 9, and Electron 44 are locked with a v6-compatible Leaflet binding', () => {
  assert.equal(packageJson.dependencies['maplibre-gl'], '^6.6.0');
  assert.equal(packageJson.dependencies.supercluster, '^9.0.0');
  assert.equal(packageJson.devDependencies.electron, '^44.0.0');
  assert.equal(packageLock.packages['node_modules/maplibre-gl'].version, '6.6.0');
  assert.equal(packageLock.packages['node_modules/supercluster'].version, '9.0.0');
  assert.equal(packageLock.packages['node_modules/electron'].version, '44.0.0');
  assert.equal(packageLock.packages['node_modules/@maplibre/maplibre-gl-leaflet'].version, '0.1.4');
  assert.match(
    packageLock.packages['node_modules/@maplibre/maplibre-gl-leaflet'].peerDependencies['maplibre-gl'],
    /\^6\.0\.0/,
  );
});

test('MapView uses the MapLibre 6 namespace import and packaged worker URL', () => {
  assert.match(mapSource, /import \* as maplibregl from ['"]maplibre-gl['"]/);
  assert.match(mapSource, /maplibre-gl-worker\.mjs\?worker&url/);
  assert.match(mapSource, /maplibregl\.config\.WORKER_URL\s*=\s*maplibreWorkerUrl/);
  assert.match(mapSource, /window\s+as\s+any\)\.maplibregl\s*=\s*maplibregl/);
});

test('bookmark rendering indexes once and re-culls on viewport movement', () => {
  assert.match(mapSource, /new Supercluster\(\{ radius: 60, maxZoom: 18, minPoints: 2 \}\)/);
  assert.match(mapSource, /index\.getClusters\(bbox, zoom\)/);
  assert.match(mapSource, /map\.on\('moveend', onMove\)/);
  assert.doesNotMatch(mapSource, /const THRESHOLD_PX = 40/);
  assert.match(mapSource, /getClusterExpansionZoom\(clusterId\)/);
  assert.match(mapSource, /currentPage \* pageSize/);
  assert.match(mapSource, /data-cluster-page/);
  assert.match(mapSource, /pageSize = 50/);
  assert.match(appSource, /const bookmarkPins = useMemo\(\(\) => bm\.bookmarks\.map/);
  assert.match(appSource, /bookmarkPins=\{bookmarkPins\}/);
});

test('Supercluster preserves exact bookmark leaves while reducing nearby points', async () => {
  const { default: Supercluster } = await import('supercluster');
  const index = new Supercluster({ radius: 60, maxZoom: 18, minPoints: 2 });
  index.load([
    { type: 'Feature', properties: { idx: 0 }, geometry: { type: 'Point', coordinates: [121.5650, 25.0330] } },
    { type: 'Feature', properties: { idx: 1 }, geometry: { type: 'Point', coordinates: [121.5651, 25.0331] } },
    { type: 'Feature', properties: { idx: 2 }, geometry: { type: 'Point', coordinates: [139.6917, 35.6895] } },
  ]);
  const features = index.getClusters([120, 24, 122, 26], 10);
  const cluster = features.find((feature) => feature.properties.cluster);
  assert.ok(cluster, 'nearby bookmarks should produce a cluster');
  assert.equal(cluster.properties.point_count, 2);
  const leaves = index.getLeaves(cluster.properties.cluster_id, cluster.properties.point_count);
  assert.deepEqual(leaves.map((leaf) => leaf.properties.idx).sort(), [0, 1]);
});

test('clipboard remains context-isolated and routes through main-process IPC', () => {
  assert.doesNotMatch(preloadSource, /require\(['"]electron['"]\)[^\n]*clipboard/);
  assert.match(preloadSource, /readText:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]clipboard:readText['"]\)/);
  assert.match(preloadSource, /writeText:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\(['"]clipboard:writeText['"],\s*text\)/);
  assert.match(mainSource, /ipcMain\.handle\(['"]clipboard:readText['"],\s*\(\)\s*=>\s*clipboard\.readText\(\)/);
  assert.match(mainSource, /ipcMain\.handle\(['"]clipboard:writeText['"],\s*async/);
  assert.match(mainSource, /ipcMain\.handle\(['"]clipboard:writeText['"][\s\S]{0,240}await clipboard\.writeText\(text\)/);
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
});
