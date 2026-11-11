import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSinglePrimitiveGeometry,
  buildWatertightManifoldGeometry,
  deriveFromCustomViews,
  diagnoseThreeViews,
  exportPrimitivesToWatertightSTL,
  extractSharpFeatureEdges,
  fixSingleDiagnosticIssue,
  getNormalizedBenchmarkPresets,
  pointToLineSegDist,
  projectPoint3DToView,
  runKernelBenchmarkSelfTest,
  sampleArcDTheta,
} from './index';
import { PRESET_CASES } from '../data/presets';
import { CadEntity, Primitive3D } from '../types/cad';

test('Coordinate invariants: First-angle projection & +dθ arc sweep', () => {
  const pt = { x: 80, y: 75, z: 45 };
  assert.deepEqual(projectPoint3DToView(pt, 'front'), { u: 80, v: 45 });
  assert.deepEqual(projectPoint3DToView(pt, 'top'), { u: 80, v: 75 });
  assert.deepEqual(projectPoint3DToView(pt, 'left'), { u: 75, v: 45 });

  // Upper semicircle [0 -> π] at (60, 28), R=32 MUST peak at (60, 60), never invert downward!
  const arcPts = sampleArcDTheta({ u: 60, v: 28 }, 32, 0, Math.PI, true, 16);
  const mid = arcPts[Math.floor((arcPts.length - 1) / 2)];
  assert.ok(Math.abs(mid.u - 60) < 1e-6);
  assert.ok(Math.abs(mid.v - 60) < 1e-6);

  // Finite segment distance must penalize collinear overhang past endpoint!
  const overhang = pointToLineSegDist(
    { u: 90, v: 40 },
    { u: 30, v: 40 },
    { u: 70, v: 40 }
  );
  assert.ok(Math.abs(overhang.dist - 20) < 1e-6);
});

test('Three.js det=-1 coordinate permutation preserves outward CCW normals & watertight STL', () => {
  const sphere: Primitive3D = {
    id: 'test_sph',
    featureId: 'f_sph',
    label: 'Sphere',
    operation: 'add',
    shape: 'sphere',
    xMin: 40,
    xMax: 80,
    yMin: 40,
    yMax: 80,
    zMin: 30,
    zMax: 70,
    centerX: 60,
    centerY: 60,
    centerZ: 50,
    radius: 20,
  };

  // In Three.js space, center (60,60,50) maps to (0, 0, 0). Every triangle normal (B-A)x(C-A) must dot > 0 with centroid!
  const geomThree = buildSinglePrimitiveGeometry(sphere, 'threejs');
  const pos = geomThree.getAttribute('position');
  assert.ok(pos.count > 100);

  let outwardCount = 0;
  const totalTris = pos.count / 3;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i),
      ay = pos.getY(i),
      az = pos.getZ(i);
    const bx = pos.getX(i + 1),
      by = pos.getY(i + 1),
      bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2),
      cy = pos.getY(i + 2),
      cz = pos.getZ(i + 2);
    assert.ok(Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz));

    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cz * 0 + cy) / 3;
    const mz = (az + bz + cz) / 3;
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * mx + ny * my + nz * mz > 0) {
      outwardCount++;
    }
  }
  assert.equal(outwardCount, totalTris, 'All Three.js triangles must face outward!');

  // Sharp edges on smooth sphere (72 radial segments) should be 0!
  const sphereEdges = extractSharpFeatureEdges(geomThree, 32);
  assert.equal(sphereEdges.getAttribute('position').count, 0);

  // STL export on bored box must contain valid facets in [0, 120] engineering space
  const boredBox: Primitive3D[] = [
    {
      id: 'b1',
      featureId: 'fb1',
      label: 'Base',
      operation: 'add',
      shape: 'box',
      xMin: 30,
      xMax: 90,
      yMin: 30,
      yMax: 90,
      zMin: 20,
      zMax: 80,
    },
    {
      id: 'h1',
      featureId: 'fh1',
      label: 'Hole',
      operation: 'subtract',
      shape: 'cylinder_z',
      xMin: 48,
      xMax: 72,
      yMin: 48,
      yMax: 72,
      zMin: 20,
      zMax: 80,
      centerX: 60,
      centerY: 60,
      radius: 12,
    },
  ];
  const stl = exportPrimitivesToWatertightSTL(boredBox, 'TestSolid');
  assert.ok(stl.startsWith('solid TestSolid'));
  assert.ok(stl.includes('facet normal'));
  assert.ok(stl.trimEnd().endsWith('endsolid TestSolid'));
});

test('No-AABB Hexagonal Prism Law: Regular hexagon lifts to exact prism, not AABB box', () => {
  const presets = getNormalizedBenchmarkPresets();
  const hexCase = presets.find((c) => c.id === 'bench_02_hex_prism_single_bore')!;
  const sols = deriveFromCustomViews(
    hexCase.entities,
    hexCase.knownViews,
    hexCase.targetView
  );
  assert.ok(sols.length >= 1);
  const posPrims = sols[0].primitives3D.filter((p) => p.operation === 'add');
  assert.ok(
    posPrims.some((p) => p.shape === 'prism'),
    'Regular hexagon must lift to exact polygonal prism, never AABB slabs!'
  );
  assert.ok(
    !posPrims.some((p) => p.shape === 'box'),
    'No AABB box fallback may remain around hexagonal prism!'
  );

  // Left view Y-span of hexFlatY must be [34.02, 85.98] (51.96mm), NOT 60mm!
  const leftSolids = sols[0].derivedEntities.filter(
    (e) => e.lineType === 'thick_solid' && e.type === 'line'
  );
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const e of leftSolids) {
    if (e.type === 'line') {
      uMin = Math.min(uMin, e.p1.u, e.p2.u);
      uMax = Math.max(uMax, e.p1.u, e.p2.u);
    }
  }
  assert.ok(
    Math.abs(uMax - uMin - 30 * Math.sqrt(3)) < 1.0,
    `Expected exact hex flat-to-flat width ~51.96mm, got ${(uMax - uMin).toFixed(2)}mm`
  );
});

test('Full 14-Case High-Difficulty Benchmark Self-Test Suite passes 14 / 14', () => {
  const report = runKernelBenchmarkSelfTest();
  assert.equal(report.totalCases, 14);
  for (const r of report.results) {
    assert.equal(
      r.passed,
      true,
      `Benchmark ${r.caseId} failed: ${r.notes} (sols=${r.solutionCount}, solid=${r.derivedSolidCount}, dashed=${r.derivedDashedCount}, tris=${r.watertightTriangles}, recall=${r.recallKnownViews})`
    );
  }
  assert.equal(report.passedCases, 14);
});

test('Classic Textbook Presets & GB/T Three-View Diagnostics + Fixes', () => {
  for (const preset of PRESET_CASES) {
    if (preset.category === 'diagnostic') {
      const issues = diagnoseThreeViews(preset.entities, preset.knownViews, 'zh-CN');
      assert.ok(
        issues.length >= 2,
        `Diagnostic preset ${preset.id} should report alignment/topology issues`
      );
      let healed: CadEntity[] = preset.entities;
      for (const iss of issues) {
        if (iss.fixPayload) {
          healed = fixSingleDiagnosticIssue(iss, healed);
        }
      }
      const afterIssues = diagnoseThreeViews(healed, preset.knownViews, 'zh-CN').filter(
        (i) => i.severity === 'error'
      );
      assert.ok(afterIssues.length < issues.filter((i) => i.severity === 'error').length);
    } else {
      const sols = deriveFromCustomViews(
        preset.entities,
        preset.knownViews,
        preset.targetView
      );
      assert.ok(sols.length >= 1, `Classic preset ${preset.id} must reconstruct cleanly`);
      const geom = buildWatertightManifoldGeometry(sols[0].primitives3D, 'threejs');
      assert.ok(geom.getAttribute('position').count >= 12);
      geom.dispose();
    }
  }
});
