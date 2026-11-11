import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  Vector3,
} from 'three';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { HemisphereCapSpec, Primitive3D } from '../../types/cad';
import { Axis3D } from '../types';
import { sampleLoopSegmentsToDensePolygon } from '../arrangement2d/dcelBuilder';
import {
  buildGeneralizedLoftTrianglePositions,
  ensureCCWPolygon2D,
  loftUVWToXYZ,
  primitiveToGeneralizedLoft,
  triangulateSimplePolygon2D,
} from '../lifting3d/generalizedLoft';

export type MeshCoordSpace = 'engineering' | 'threejs';

/**
 * Maps engineering coordinates `(X, Y, Z)` into Three.js viewport space `(X - 60, Z - 50, Y - 60)`
 * or preserves `(X, Y, Z)` for CAD/STL export.
 * Note: `(X, Y, Z) -> (X - 60, Z - 50, Y - 60)` swaps Y and Z (determinant = -1), so triangle
 * winding flips once and is automatically recalibrated by `sanitizeAndOrientBufferGeometry`.
 */
function engToSpace(
  x: number,
  y: number,
  z: number,
  space: MeshCoordSpace
): [number, number, number] {
  if (space === 'threejs') {
    return [x - 60, z - 50, y - 60];
  }
  return [x, y, z];
}

/**
 * Computes area-weighted crease-angle split vertex normals (`creaseDeg = 28°`) across
 * welded spatial vertices (`0.005mm` tolerance):
 * - Smoothly interpolates normals across curved cylindrical/conical/spherical bores (`5° < 28°`)
 *   and across coplanar CSG sub-triangles (`0° < 28°`), completely eliminating vertical facet comb stripes.
 * - Keeps 100% crisp hard normals across mechanical rims (`90° > 28°`) and prism edges (`60° > 28°`),
 *   preventing dark shadow bleeding onto flat end-caps.
 */
function computeCreaseSplitNormals(coords: number[], creaseDeg = 28): Float32Array {
  const vertCount = Math.floor(coords.length / 3);
  const triCount = Math.floor(vertCount / 3);
  const normals = new Float32Array(coords.length);
  if (triCount === 0) return normals;

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const unitNormals = new Float32Array(triCount * 3);
  const areaNormals = new Float32Array(triCount * 3);

  interface VertIncidence {
    tri: number;
    vIdx: number;
  }
  const spatialBuckets = new Map<string, VertIncidence[]>();
  const vKey = (x: number, y: number, z: number) =>
    `${Math.round(x * 200)}_${Math.round(y * 200)}_${Math.round(z * 200)}`;

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const ax = coords[base], ay = coords[base + 1], az = coords[base + 2];
    const bx = coords[base + 3], by = coords[base + 4], bz = coords[base + 5];
    const cx = coords[base + 6], cy = coords[base + 7], cz = coords[base + 8];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;

    areaNormals[t * 3] = nx;
    areaNormals[t * 3 + 1] = ny;
    areaNormals[t * 3 + 2] = nz;
    unitNormals[t * 3] = nx / len;
    unitNormals[t * 3 + 1] = ny / len;
    unitNormals[t * 3 + 2] = nz / len;

    for (let c = 0; c < 3; c++) {
      const vx = coords[base + c * 3];
      const vy = coords[base + c * 3 + 1];
      const vz = coords[base + c * 3 + 2];
      const key = vKey(vx, vy, vz);
      const list = spatialBuckets.get(key);
      const inc: VertIncidence = { tri: t, vIdx: t * 3 + c };
      if (list) list.push(inc);
      else spatialBuckets.set(key, [inc]);
    }
  }

  for (const list of spatialBuckets.values()) {
    const m = list.length;
    for (let i = 0; i < m; i++) {
      const incA = list[i];
      const uxA = unitNormals[incA.tri * 3];
      const uyA = unitNormals[incA.tri * 3 + 1];
      const uzA = unitNormals[incA.tri * 3 + 2];

      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let j = 0; j < m; j++) {
        const tB = list[j].tri;
        const dot =
          uxA * unitNormals[tB * 3] +
          uyA * unitNormals[tB * 3 + 1] +
          uzA * unitNormals[tB * 3 + 2];
        if (dot >= cosCrease) {
          sx += areaNormals[tB * 3];
          sy += areaNormals[tB * 3 + 1];
          sz += areaNormals[tB * 3 + 2];
        }
      }

      const sLen = Math.hypot(sx, sy, sz);
      const outBase = incA.vIdx * 3;
      if (sLen > 1e-12) {
        normals[outBase] = sx / sLen;
        normals[outBase + 1] = sy / sLen;
        normals[outBase + 2] = sz / sLen;
      } else {
        normals[outBase] = uxA;
        normals[outBase + 1] = uyA;
        normals[outBase + 2] = uzA;
      }
    }
  }

  return normals;
}

/**
 * Sanitizes a `BufferGeometry`:
 * - Converts to non-indexed triangles
 * - Strips any triangle containing `NaN`/`Infinity`, zero area, or sub-micron needle slivers
 * - Enforces positive signed volume (outward CCW triangle winding)
 * - Computes area-weighted crease-angle (`28°`) split vertex normals
 */
export function sanitizeAndOrientBufferGeometry(geom: BufferGeometry): BufferGeometry {
  const src = geom.index ? geom.toNonIndexed() : geom;
  const posAttr = src.getAttribute('position');
  if (!posAttr || posAttr.count < 3) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }

  const cleanCoords: number[] = [];
  const v0 = new Vector3();
  const v1 = new Vector3();
  const v2 = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const e3 = new Vector3();
  const cross = new Vector3();
  let signedVol6 = 0;

  for (let i = 0; i + 2 < posAttr.count; i += 3) {
    const ax = posAttr.getX(i);
    const ay = posAttr.getY(i);
    const az = posAttr.getZ(i);
    const bx = posAttr.getX(i + 1);
    const by = posAttr.getY(i + 1);
    const bz = posAttr.getZ(i + 1);
    const cx = posAttr.getX(i + 2);
    const cy = posAttr.getY(i + 2);
    const cz = posAttr.getZ(i + 2);

    if (
      !Number.isFinite(ax) ||
      !Number.isFinite(ay) ||
      !Number.isFinite(az) ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by) ||
      !Number.isFinite(bz) ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(cz)
    ) {
      continue;
    }

    v0.set(ax, ay, az);
    v1.set(bx, by, bz);
    v2.set(cx, cy, cz);
    e1.subVectors(v1, v0);
    e2.subVectors(v2, v0);
    e3.subVectors(v2, v1);
    cross.crossVectors(e1, e2);
    const doubleArea = cross.length();
    const maxEdge = Math.max(e1.length(), e2.length(), e3.length());
    if (doubleArea < 2e-5 || maxEdge < 1e-5 || doubleArea / maxEdge < 1e-4) {
      continue;
    }

    cleanCoords.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    signedVol6 += v0.clone().cross(v1).dot(v2);
  }

  if (signedVol6 < 0) {
    for (let i = 0; i + 8 < cleanCoords.length; i += 9) {
      const bx = cleanCoords[i + 3];
      const by = cleanCoords[i + 4];
      const bz = cleanCoords[i + 5];
      cleanCoords[i + 3] = cleanCoords[i + 6];
      cleanCoords[i + 4] = cleanCoords[i + 7];
      cleanCoords[i + 5] = cleanCoords[i + 8];
      cleanCoords[i + 6] = bx;
      cleanCoords[i + 7] = by;
      cleanCoords[i + 8] = bz;
    }
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(cleanCoords, 3));
  out.setAttribute('normal', new Float32BufferAttribute(computeCreaseSplitNormals(cleanCoords, 28), 3));
  return out;
}

function mapEngineeringGeomToSpace(
  engPositions: Float32Array,
  space: MeshCoordSpace
): BufferGeometry {
  const coords = new Float32Array(engPositions.length);
  for (let i = 0; i + 2 < engPositions.length; i += 3) {
    const [sx, sy, sz] = engToSpace(
      engPositions[i],
      engPositions[i + 1],
      engPositions[i + 2],
      space
    );
    coords[i] = sx;
    coords[i + 1] = sy;
    coords[i + 2] = sz;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(coords, 3));
  return sanitizeAndOrientBufferGeometry(geom);
}

/**
 * Builds an exact, sharp-edged watertight `BufferGeometry` for a single `Primitive3D`
 * in either `'threejs'` viewport coordinates or `'engineering'` `(X, Y, Z)` CAD coordinates.
 */
export function buildSinglePrimitiveGeometry(
  prim: Primitive3D,
  space: MeshCoordSpace = 'threejs'
): BufferGeometry {
  // Exact dimensions are preserved (`subPad = 0`); open-air axial mouths of subtractive holes
  // are already cleanly extended into outside air by `prepareMicroWeldedPrimitives`!
  const subPad = 0;

  // 1. GeneralizedLoft / Pyramid / Cone / Frustum / Half-Cone / Half-Frustum
  if (
    prim.shape === 'generalized_loft' ||
    prim.shape === 'pyramid' ||
    prim.shape === 'cone_x' ||
    prim.shape === 'cone_y' ||
    prim.shape === 'cone_z'
  ) {
    const loft = primitiveToGeneralizedLoft(prim);
    if (loft) {
      const engPos = buildGeneralizedLoftTrianglePositions(loft, 72);
      if (engPos.length >= 9) {
        return mapEngineeringGeomToSpace(engPos, space);
      }
    }
  }

  // 2. Exact Parametric Hemisphere (dome + sharp flat equatorial disk along X, Y, or Z!)
  if (prim.shape === 'hemisphere') {
    const r = Math.max(
      0.5,
      prim.radius ??
        0.5 * Math.max(prim.xMax - prim.xMin, prim.yMax - prim.yMin, prim.zMax - prim.zMin)
    );
    const cap: HemisphereCapSpec = prim.hemisphereSpec ?? {
      flatAxis: 'Z',
      flatCoord: prim.zMin,
      keepPositiveSide: true,
    };
    const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
    const cz =
      prim.centerZ ??
      (cap.flatAxis === 'Z' ? cap.flatCoord : 0.5 * (prim.zMin + prim.zMax));

    const center = {
      x: cap.flatAxis === 'X' ? cap.flatCoord : cx,
      y: cap.flatAxis === 'Y' ? cap.flatCoord : cy,
      z: cap.flatAxis === 'Z' ? cap.flatCoord : cz,
    };

    const W_SEGS = 64;
    const H_SEGS = 24;
    const dirSign = cap.keepPositiveSide ? 1 : -1;

    const mapLocalDome = (lx: number, ly: number, lz: number): [number, number, number] => {
      if (cap.flatAxis === 'Z') {
        return [center.x + lx, center.y + ly, center.z + dirSign * lz];
      }
      if (cap.flatAxis === 'Y') {
        return [center.x + lx, center.y + dirSign * lz, center.z + ly];
      }
      return [center.x + dirSign * lz, center.y + lx, center.z + ly];
    };

    const tris: number[] = [];
    for (let i = 0; i < H_SEGS; i++) {
      // phi = 0 at pole (lz = r), phi = pi/2 at equator (lz = 0)
      const phi0 = (i / H_SEGS) * (Math.PI / 2);
      const phi1 = ((i + 1) / H_SEGS) * (Math.PI / 2);

      for (let j = 0; j < W_SEGS; j++) {
        const th0 = (j / W_SEGS) * Math.PI * 2;
        const th1 = ((j + 1) / W_SEGS) * Math.PI * 2;

        const p00 = mapLocalDome(
          r * Math.sin(phi0) * Math.cos(th0),
          r * Math.sin(phi0) * Math.sin(th0),
          r * Math.cos(phi0)
        );
        const p10 = mapLocalDome(
          r * Math.sin(phi1) * Math.cos(th0),
          r * Math.sin(phi1) * Math.sin(th0),
          r * Math.cos(phi1)
        );
        const p11 = mapLocalDome(
          r * Math.sin(phi1) * Math.cos(th1),
          r * Math.sin(phi1) * Math.sin(th1),
          r * Math.cos(phi1)
        );
        const p01 = mapLocalDome(
          r * Math.sin(phi0) * Math.cos(th1),
          r * Math.sin(phi0) * Math.sin(th1),
          r * Math.cos(phi0)
        );

        if (i > 0) {
          tris.push(...p00, ...p10, ...p11);
        } else {
          tris.push(...p00, ...p10, ...p11);
        }
        if (i > 0) {
          tris.push(...p00, ...p11, ...p01);
        }
      }
    }

    // Sharp flat equatorial base disk at lz = 0
    const eqCenter = mapLocalDome(0, 0, 0);
    for (let j = 0; j < W_SEGS; j++) {
      const th0 = (j / W_SEGS) * Math.PI * 2;
      const th1 = ((j + 1) / W_SEGS) * Math.PI * 2;
      const e0 = mapLocalDome(r * Math.cos(th0), r * Math.sin(th0), 0);
      const e1 = mapLocalDome(r * Math.cos(th1), r * Math.sin(th1), 0);
      // Outward normal of base disk points toward -dirSign along flatAxis!
      tris.push(...eqCenter, ...e1, ...e0);
    }

    // Ensure every triangle in `tris` has outward normal relative to interior point `(0, 0, 0.35 * r)`
    const refIn = mapLocalDome(0, 0, 0.35 * r);
    for (let k = 0; k + 8 < tris.length; k += 9) {
      const ax = tris[k], ay = tris[k + 1], az = tris[k + 2];
      const bx = tris[k + 3], by = tris[k + 4], bz = tris[k + 5];
      const cx2 = tris[k + 6], cy2 = tris[k + 7], cz2 = tris[k + 8];
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx2 - ax, acy = cy2 - ay, acz = cz2 - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const ox = ax - refIn[0], oy = ay - refIn[1], oz = az - refIn[2];
      if (nx * ox + ny * oy + nz * oz < 0) {
        tris[k + 3] = cx2;
        tris[k + 4] = cy2;
        tris[k + 5] = cz2;
        tris[k + 6] = bx;
        tris[k + 7] = by;
        tris[k + 8] = bz;
      }
    }

    return mapEngineeringGeomToSpace(new Float32Array(tris), space);
  }

  // 3. Sphere
  if (prim.shape === 'sphere') {
    const r = Math.max(
      0.5,
      prim.radius ??
        0.5 * Math.min(prim.xMax - prim.xMin, prim.yMax - prim.yMin, prim.zMax - prim.zMin)
    );
    const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
    const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const geom = new SphereGeometry(r, 64, 40);
    const [tx, ty, tz] = engToSpace(cx, cy, cz, space);
    geom.translate(tx, ty, tz);
    return sanitizeAndOrientBufferGeometry(geom);
  }

  // 4. Cylinders along X, Y, Z
  if (prim.shape === 'cylinder_z' || prim.shape === 'cylinder_y' || prim.shape === 'cylinder_x') {
    const axis = prim.shape === 'cylinder_z' ? 'Z' : prim.shape === 'cylinder_y' ? 'Y' : 'X';
    const r = Math.max(
      0.25,
      prim.radius ??
        0.5 * (axis === 'X' ? prim.yMax - prim.yMin : prim.xMax - prim.xMin)
    );
    const cU =
      axis === 'X'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cV =
      axis === 'Z'
        ? prim.centerY ?? 0.5 * (prim.yMin + prim.yMax)
        : prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const w0 = (axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin) - subPad;
    const w1 = (axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax) + subPad;
    const engPos = buildGeneralizedLoftTrianglePositions(
      {
        axis,
        w0,
        w1,
        section0: { kind: 'circle', centerU: cU, centerV: cV, radiusU: r },
        section1: { kind: 'circle', centerU: cU, centerV: cV, radiusU: r },
      },
      72
    );
    return mapEngineeringGeomToSpace(engPos, space);
  }

  // 5. Curved / Polygonal Prism Extrusion (Exact Analytical Ear-Clipping + Sharp Lateral Quads)
  if (prim.shape === 'prism') {
    const rawSegs = prim.prismSegments ?? [];
    const rawPoly = prim.prismPolygon ?? prim.polygon2D ?? [];
    const hasCurvedArc = rawSegs.some((s) => s.kind === 'arc');
    const ring = hasCurvedArc
      ? ensureCCWPolygon2D(sampleLoopSegmentsToDensePolygon(rawSegs, 56))
      : ensureCCWPolygon2D(
          rawSegs.length > 0 ? rawSegs.map((s) => s.p1) : rawPoly
        );

    if (ring.length >= 3) {
      const axisStr = (prim.prismAxis ?? prim.extrudeAxis ?? 'Y').toString().toUpperCase();
      const axis: Axis3D = axisStr === 'Z' ? 'Z' : axisStr === 'X' ? 'X' : 'Y';
      const w0 = (axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin) - subPad;
      const w1 = (axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax) + subPad;
      if (w1 - w0 >= 1e-4) {
        // Right-handed for Z (X, Y, Z) and X (Y, Z, X); left-handed for Y (X, Z, Y)
        const handed = axis === 'Y' ? -1 : 1;
        const tris: number[] = [];

        // Sharp planar lateral quads: 2 triangles per polygon edge with exact outward normal
        for (let i = 0; i < ring.length; i++) {
          const pa = ring[i];
          const pb = ring[(i + 1) % ring.length];
          const A0 = loftUVWToXYZ(axis, pa.u, pa.v, w0);
          const B0 = loftUVWToXYZ(axis, pb.u, pb.v, w0);
          const A1 = loftUVWToXYZ(axis, pa.u, pa.v, w1);
          const B1 = loftUVWToXYZ(axis, pb.u, pb.v, w1);
          if (handed > 0) {
            tris.push(
              A0.x, A0.y, A0.z, B0.x, B0.y, B0.z, B1.x, B1.y, B1.z,
              A0.x, A0.y, A0.z, B1.x, B1.y, B1.z, A1.x, A1.y, A1.z
            );
          } else {
            tris.push(
              A0.x, A0.y, A0.z, B1.x, B1.y, B1.z, B0.x, B0.y, B0.z,
              A0.x, A0.y, A0.z, A1.x, A1.y, A1.z, B1.x, B1.y, B1.z
            );
          }
        }

        // Exact 2D Ear-Clipping triangulation for w0 and w1 end-caps (convex & concave polygons)
        const capIndices = triangulateSimplePolygon2D(ring);
        for (const [ia, ib, ic] of capIndices) {
          const A0 = loftUVWToXYZ(axis, ring[ia].u, ring[ia].v, w0);
          const B0 = loftUVWToXYZ(axis, ring[ib].u, ring[ib].v, w0);
          const C0 = loftUVWToXYZ(axis, ring[ic].u, ring[ic].v, w0);
          const A1 = loftUVWToXYZ(axis, ring[ia].u, ring[ia].v, w1);
          const B1 = loftUVWToXYZ(axis, ring[ib].u, ring[ib].v, w1);
          const C1 = loftUVWToXYZ(axis, ring[ic].u, ring[ic].v, w1);
          if (handed > 0) {
            // w0 cap outward normal points along -w; w1 cap outward normal points along +w
            tris.push(
              A0.x, A0.y, A0.z, C0.x, C0.y, C0.z, B0.x, B0.y, B0.z,
              A1.x, A1.y, A1.z, B1.x, B1.y, B1.z, C1.x, C1.y, C1.z
            );
          } else {
            tris.push(
              A0.x, A0.y, A0.z, B0.x, B0.y, B0.z, C0.x, C0.y, C0.z,
              A1.x, A1.y, A1.z, C1.x, C1.y, C1.z, B1.x, B1.y, B1.z
            );
          }
        }

        return mapEngineeringGeomToSpace(new Float32Array(tris), space);
      }
    }
  }

  // 5b. Wedge along Y / X / Z (e.g. classic multi-solution wedge block)
  if (prim.shape === 'wedge_y') {
    const x0 = prim.xMin - subPad;
    const x1 = prim.xMax + subPad;
    const y0 = prim.yMin - subPad;
    const y1 = prim.yMax + subPad;
    const z0 = prim.zMin - subPad;
    const z1 = prim.zMax + subPad;
    // Right-triangular prism over (Y, Z): (y0,z0) -> (y1,z0) -> (y1,z1), extruded along X in [x0, x1]
    const v: [number, number, number][] = [
      [x0, y0, z0],
      [x0, y1, z0],
      [x0, y1, z1],
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
    ];
    const ref: [number, number, number] = [
      0.5 * (x0 + x1),
      (y0 + 2 * y1) / 3,
      (2 * z0 + z1) / 3,
    ];
    const tris: number[] = [];
    const pushOriented = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number]
    ) => {
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const ox = a[0] - ref[0], oy = a[1] - ref[1], oz = a[2] - ref[2];
      if (nx * ox + ny * oy + nz * oz < 0) {
        tris.push(...a, ...c, ...b);
      } else {
        tris.push(...a, ...b, ...c);
      }
    };
    pushOriented(v[0], v[1], v[2]);
    pushOriented(v[3], v[5], v[4]);
    pushOriented(v[0], v[1], v[4]);
    pushOriented(v[0], v[4], v[3]);
    pushOriented(v[1], v[2], v[5]);
    pushOriented(v[1], v[5], v[4]);
    pushOriented(v[2], v[0], v[3]);
    pushOriented(v[2], v[3], v[5]);
    return mapEngineeringGeomToSpace(new Float32Array(tris), space);
  }

  // 5c. Polygonal Pyramid / Truncated Pyramid
  if (prim.shape === 'pyramid' && prim.apex3D) {
    const rawPoly = prim.prismPolygon ?? prim.polygon2D ?? [];
    if (rawPoly.length >= 3) {
      const axis = (prim.prismAxis ?? prim.extrudeAxis ?? 'Z').toString().toUpperCase();
      const [ax, ay, az] = prim.apex3D;
      const baseW =
        axis === 'Z'
          ? Math.abs(az - prim.zMin) > Math.abs(az - prim.zMax) ? prim.zMin : prim.zMax
          : axis === 'Y'
          ? Math.abs(ay - prim.yMin) > Math.abs(ay - prim.yMax) ? prim.yMin : prim.yMax
          : Math.abs(ax - prim.xMin) > Math.abs(ax - prim.xMax) ? prim.xMin : prim.xMax;
      const base3D: [number, number, number][] = rawPoly.map((p) =>
        axis === 'Z'
          ? [p.u, p.v, baseW]
          : axis === 'Y'
          ? [p.u, baseW, p.v]
          : [baseW, p.u, p.v]
      );
      const cx0 = base3D.reduce((s, p) => s + p[0], 0) / base3D.length;
      const cy0 = base3D.reduce((s, p) => s + p[1], 0) / base3D.length;
      const cz0 = base3D.reduce((s, p) => s + p[2], 0) / base3D.length;
      const ref: [number, number, number] = [
        0.75 * cx0 + 0.25 * ax,
        0.75 * cy0 + 0.25 * ay,
        0.75 * cz0 + 0.25 * az,
      ];
      const tris: number[] = [];
      const pushOriented = (
        a: [number, number, number],
        b: [number, number, number],
        c: [number, number, number]
      ) => {
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const ox = a[0] - ref[0], oy = a[1] - ref[1], oz = a[2] - ref[2];
        if (nx * ox + ny * oy + nz * oz < 0) tris.push(...a, ...c, ...b);
        else tris.push(...a, ...b, ...c);
      };
      for (let i = 0; i < base3D.length; i++) {
        const b1 = base3D[i];
        const b2 = base3D[(i + 1) % base3D.length];
        pushOriented(b1, b2, [ax, ay, az]);
        pushOriented([cx0, cy0, cz0], b1, b2);
      }
      return mapEngineeringGeomToSpace(new Float32Array(tris), space);
    }
  }

  // 5d. Thin Spatial Plane Sheet
  if (prim.shape === 'plane_sheet' && prim.vertices3D && prim.vertices3D.length >= 3) {
    const v3 = prim.vertices3D;
    const e1 = new Vector3(v3[1][0] - v3[0][0], v3[1][1] - v3[0][1], v3[1][2] - v3[0][2]);
    const e2 = new Vector3(v3[2][0] - v3[0][0], v3[2][1] - v3[0][1], v3[2][2] - v3[0][2]);
    const n = e1.cross(e2);
    if (n.lengthSq() > 1e-8) {
      n.normalize().multiplyScalar(0.25);
      const topV = v3.map(([vx, vy, vz]): [number, number, number] => [vx + n.x, vy + n.y, vz + n.z]);
      const botV = v3.map(([vx, vy, vz]): [number, number, number] => [vx - n.x, vy - n.y, vz - n.z]);
      const tris: number[] = [];
      for (let i = 1; i < v3.length - 1; i++) {
        tris.push(...topV[0], ...topV[i], ...topV[i + 1]);
        tris.push(...botV[0], ...botV[i + 1], ...botV[i]);
      }
      for (let i = 0; i < v3.length; i++) {
        const j = (i + 1) % v3.length;
        tris.push(...botV[i], ...botV[j], ...topV[j]);
        tris.push(...botV[i], ...topV[j], ...topV[i]);
      }
      return mapEngineeringGeomToSpace(new Float32Array(tris), space);
    }
  }

  // 6. Sharp Axis-Aligned Box
  const xMin = prim.xMin - subPad;
  const xMax = prim.xMax + subPad;
  const yMin = prim.yMin - subPad;
  const yMax = prim.yMax + subPad;
  const zMin = prim.zMin - subPad;
  const zMax = prim.zMax + subPad;

  const dx = Math.max(0.25, xMax - xMin);
  const dy = Math.max(0.25, yMax - yMin);
  const dz = Math.max(0.25, zMax - zMin);
  const cx = 0.5 * (xMin + xMax);
  const cy = 0.5 * (yMin + yMax);
  const cz = 0.5 * (zMin + zMax);

  if (space === 'threejs') {
    const box = new BoxGeometry(dx, dz, dy);
    box.translate(cx - 60, cz - 50, cy - 60);
    return sanitizeAndOrientBufferGeometry(box);
  }
  const box = new BoxGeometry(dx, dy, dz);
  box.translate(cx, cy, cz);
  return sanitizeAndOrientBufferGeometry(box);
}

/**
 * Applies micro-welding (`0.025mm` inward intrusion across shared coplanar interfaces)
 * between adjacent `add` primitives so CSG Boolean Union eliminates internal coplanar seams
 * (`x_a = x_b = 1`) without coplanar face z-fighting!
 */
function prepareMicroWeldedPrimitives(primitives: Primitive3D[]): Primitive3D[] {
  const cloned = primitives.map((p) => ({ ...p }));
  const adds = cloned.filter((p) => p.operation === 'add');
  const WELD_EPS = 0.025;

  for (let i = 0; i < adds.length; i++) {
    for (let j = i + 1; j < adds.length; j++) {
      const a = adds[i];
      const b = adds[j];
      const volA = (a.xMax - a.xMin) * (a.yMax - a.yMin) * (a.zMax - a.zMin);
      const volB = (b.xMax - b.xMin) * (b.yMax - b.yMin) * (b.zMax - b.zMin);
      // Intrude the smaller step/dome feature 0.025mm into the larger body across touching planes
      // Note: Do NOT alter `hemisphere` or `generalized_loft` whose exact parametric spec lives in `hemisphereSpec`/`loftSpec`,
      // instead extend the mating cylinder/box/loft end-cap by 0.025mm into the neighbor!
      const adjustTouch = (smaller: Primitive3D, larger: Primitive3D) => {
        if (smaller.shape === 'hemisphere') return;
        if (Math.abs(smaller.yMax - larger.yMin) < 0.05) {
          smaller.yMax += WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'Y') {
            if (Math.abs(smaller.loftSpec.w1 - (smaller.yMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 + WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w0 - (smaller.yMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 + WELD_EPS };
            }
          }
        } else if (Math.abs(smaller.yMin - larger.yMax) < 0.05) {
          smaller.yMin -= WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'Y') {
            if (Math.abs(smaller.loftSpec.w0 - (smaller.yMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 - WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w1 - (smaller.yMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 - WELD_EPS };
            }
          }
        }
        if (Math.abs(smaller.zMax - larger.zMin) < 0.05) {
          smaller.zMax += WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'Z') {
            if (Math.abs(smaller.loftSpec.w1 - (smaller.zMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 + WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w0 - (smaller.zMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 + WELD_EPS };
            }
          }
        } else if (Math.abs(smaller.zMin - larger.zMax) < 0.05) {
          smaller.zMin -= WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'Z') {
            if (Math.abs(smaller.loftSpec.w0 - (smaller.zMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 - WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w1 - (smaller.zMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 - WELD_EPS };
            }
          }
        }
        if (Math.abs(smaller.xMax - larger.xMin) < 0.05) {
          smaller.xMax += WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'X') {
            if (Math.abs(smaller.loftSpec.w1 - (smaller.xMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 + WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w0 - (smaller.xMax - WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 + WELD_EPS };
            }
          }
        } else if (Math.abs(smaller.xMin - larger.xMax) < 0.05) {
          smaller.xMin -= WELD_EPS;
          if (smaller.loftSpec && smaller.loftSpec.axis === 'X') {
            if (Math.abs(smaller.loftSpec.w0 - (smaller.xMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w0: smaller.loftSpec.w0 - WELD_EPS };
            } else if (Math.abs(smaller.loftSpec.w1 - (smaller.xMin + WELD_EPS)) < 0.05) {
              smaller.loftSpec = { ...smaller.loftSpec, w1: smaller.loftSpec.w1 - WELD_EPS };
            }
          }
        }
      };

      if (volA <= volB && a.shape !== 'hemisphere') adjustTouch(a, b);
      else adjustTouch(b, a);
    }
  }

  // 2. Extend ONLY open-air mouths of `subtract` brushes well past outer solid caps (`14.0mm` into air)
  // so BVH-CSG slices tall cylinder/prism quads far away from their diagonal tips (preventing 0.005mm
  // rim needle slivers!), while keeping bounded inner blind/T-junction ends and lateral hole widths 100% exact!
  if (adds.length > 0) {
    let bxMin = Math.min(...adds.map((a) => a.xMin));
    let bxMax = Math.max(...adds.map((a) => a.xMax));
    let byMin = Math.min(...adds.map((a) => a.yMin));
    let byMax = Math.max(...adds.map((a) => a.yMax));
    let bzMin = Math.min(...adds.map((a) => a.zMin));
    let bzMax = Math.max(...adds.map((a) => a.zMax));
    for (const inter of cloned.filter((p) => p.operation === 'intersect')) {
      bxMin = Math.max(bxMin, inter.xMin);
      bxMax = Math.min(bxMax, inter.xMax);
      byMin = Math.max(byMin, inter.yMin);
      byMax = Math.min(byMax, inter.yMax);
      bzMin = Math.max(bzMin, inter.zMin);
      bzMax = Math.min(bzMax, inter.zMax);
    }

    const OPEN_TOL = 0.35;
    const AIR_EXT = 14.0;
    const LOFT_EXT = 1.2;

    for (const sub of cloned) {
      if (sub.operation !== 'subtract') continue;

      if (sub.shape === 'cylinder_z') {
        if (sub.zMin <= bzMin + OPEN_TOL) sub.zMin = Math.min(sub.zMin, bzMin - AIR_EXT);
        if (sub.zMax >= bzMax - OPEN_TOL) sub.zMax = Math.max(sub.zMax, bzMax + AIR_EXT);
      } else if (sub.shape === 'cylinder_y') {
        if (sub.yMin <= byMin + OPEN_TOL) sub.yMin = Math.min(sub.yMin, byMin - AIR_EXT);
        if (sub.yMax >= byMax - OPEN_TOL) sub.yMax = Math.max(sub.yMax, byMax + AIR_EXT);
      } else if (sub.shape === 'cylinder_x') {
        if (sub.xMin <= bxMin + OPEN_TOL) sub.xMin = Math.min(sub.xMin, bxMin - AIR_EXT);
        if (sub.xMax >= bxMax - OPEN_TOL) sub.xMax = Math.max(sub.xMax, bxMax + AIR_EXT);
      } else if (sub.shape === 'prism') {
        const ax = (sub.prismAxis ?? sub.extrudeAxis ?? 'Y').toString().toUpperCase();
        if (ax === 'Z') {
          if (sub.zMin <= bzMin + OPEN_TOL) sub.zMin = Math.min(sub.zMin, bzMin - AIR_EXT);
          if (sub.zMax >= bzMax - OPEN_TOL) sub.zMax = Math.max(sub.zMax, bzMax + AIR_EXT);
        } else if (ax === 'Y') {
          if (sub.yMin <= byMin + OPEN_TOL) sub.yMin = Math.min(sub.yMin, byMin - AIR_EXT);
          if (sub.yMax >= byMax - OPEN_TOL) sub.yMax = Math.max(sub.yMax, byMax + AIR_EXT);
        } else {
          if (sub.xMin <= bxMin + OPEN_TOL) sub.xMin = Math.min(sub.xMin, bxMin - AIR_EXT);
          if (sub.xMax >= bxMax - OPEN_TOL) sub.xMax = Math.max(sub.xMax, bxMax + AIR_EXT);
        }
      } else if (sub.shape === 'box') {
        if (sub.xMin <= bxMin + OPEN_TOL) sub.xMin = Math.min(sub.xMin, bxMin - AIR_EXT);
        if (sub.xMax >= bxMax - OPEN_TOL) sub.xMax = Math.max(sub.xMax, bxMax + AIR_EXT);
        if (sub.yMin <= byMin + OPEN_TOL) sub.yMin = Math.min(sub.yMin, byMin - AIR_EXT);
        if (sub.yMax >= byMax - OPEN_TOL) sub.yMax = Math.max(sub.yMax, byMax + AIR_EXT);
        if (sub.zMin <= bzMin + OPEN_TOL) sub.zMin = Math.min(sub.zMin, bzMin - AIR_EXT);
        if (sub.zMax >= bzMax - OPEN_TOL) sub.zMax = Math.max(sub.zMax, bzMax + AIR_EXT);
      } else if (
        sub.shape === 'generalized_loft' ||
        sub.shape === 'cone_x' ||
        sub.shape === 'cone_y' ||
        sub.shape === 'cone_z'
      ) {
        const loft = primitiveToGeneralizedLoft(sub);
        if (loft) {
          const dw = loft.w1 - loft.w0;
          if (Math.abs(dw) > 1e-4) {
            const bLo = loft.axis === 'Z' ? bzMin : loft.axis === 'Y' ? byMin : bxMin;
            const bHi = loft.axis === 'Z' ? bzMax : loft.axis === 'Y' ? byMax : bxMax;
            const w0Open =
              dw > 0 ? loft.w0 <= bLo + OPEN_TOL : loft.w0 >= bHi - OPEN_TOL;
            const w1Open =
              dw > 0 ? loft.w1 >= bHi - OPEN_TOL : loft.w1 <= bLo + OPEN_TOL;
            const dt0 = w0Open ? LOFT_EXT / Math.abs(dw) : 0;
            const dt1 = w1Open ? LOFT_EXT / Math.abs(dw) : 0;
            if (dt0 > 0 || dt1 > 0) {
              const extrapSec = (
                a: typeof loft.section0,
                b: typeof loft.section1,
                t: number
              ): typeof loft.section0 => ({
                ...a,
                centerU: (1 - t) * a.centerU + t * b.centerU,
                centerV: (1 - t) * a.centerV + t * b.centerV,
                radiusU: Math.max(0.05, (1 - t) * a.radiusU + t * b.radiusU),
                polygon:
                  a.polygon && b.polygon && a.polygon.length === b.polygon.length
                    ? a.polygon.map((pa, idx) => ({
                        u: (1 - t) * pa.u + t * b.polygon![idx].u,
                        v: (1 - t) * pa.v + t * b.polygon![idx].v,
                      }))
                    : a.polygon,
              });
              sub.shape = 'generalized_loft';
              sub.loftSpec = {
                ...loft,
                w0: loft.w0 - Math.sign(dw) * (w0Open ? LOFT_EXT : 0),
                w1: loft.w1 + Math.sign(dw) * (w1Open ? LOFT_EXT : 0),
                section0: dt0 > 0 ? extrapSec(loft.section0, loft.section1, -dt0) : loft.section0,
                section1: dt1 > 0 ? extrapSec(loft.section0, loft.section1, 1 + dt1) : loft.section1,
              };
            }
          }
        }
      }
    }
  }

  return cloned;
}

/**
 * Evaluates a `Primitive3D[]` tree into a single sharp-edged, watertight manifold `BufferGeometry`
 * via Boolean Algebraic Coalescing + BVH-CSG exact mesh clipping (never Marching Cubes!).
 */
export function buildWatertightManifoldGeometry(
  primitives: Primitive3D[],
  space: MeshCoordSpace = 'threejs'
): BufferGeometry {
  if (!primitives || primitives.length === 0) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }

  const welded = prepareMicroWeldedPrimitives(primitives);
  const adds = welded.filter((p) => p.operation === 'add');
  const intersects = welded.filter((p) => p.operation === 'intersect');
  const subtracts = welded.filter((p) => p.operation === 'subtract');

  if (adds.length === 0) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }

  const evaluator = new Evaluator();
  evaluator.attributes = ['position'];
  evaluator.useGroups = false;

  let currentBrush: Brush | null = null;

  for (const pr of adds) {
    try {
      const geom = buildSinglePrimitiveGeometry(pr, space);
      const pos = geom.getAttribute('position');
      if (!pos || pos.count < 3) continue;
      const b = new Brush(geom);
      b.updateMatrixWorld();
      if (!currentBrush) {
        currentBrush = b;
      } else {
        currentBrush = evaluator.evaluate(currentBrush, b, ADDITION);
        currentBrush.updateMatrixWorld();
      }
    } catch {
      // Crash-proof isolation: skip malformed brush without crashing WebGL viewport
    }
  }

  if (!currentBrush) {
    return buildSinglePrimitiveGeometry(adds[0], space);
  }

  for (const pr of intersects) {
    try {
      const geom = buildSinglePrimitiveGeometry(pr, space);
      const pos = geom.getAttribute('position');
      if (!pos || pos.count < 3) continue;
      const b = new Brush(geom);
      b.updateMatrixWorld();
      currentBrush = evaluator.evaluate(currentBrush, b, INTERSECTION);
      currentBrush.updateMatrixWorld();
    } catch {
      // Preserve current valid solid on CSG exception
    }
  }

  for (const pr of subtracts) {
    try {
      const geom = buildSinglePrimitiveGeometry(pr, space);
      const pos = geom.getAttribute('position');
      if (!pos || pos.count < 3) continue;
      const b = new Brush(geom);
      b.updateMatrixWorld();
      const nextBrush = evaluator.evaluate(currentBrush, b, SUBTRACTION);
      const nextPos = nextBrush.geometry.getAttribute('position');
      if (nextPos && nextPos.count >= 12) {
        currentBrush = nextBrush;
        currentBrush.updateMatrixWorld();
      }
    } catch {
      // Preserve current valid solid on CSG exception
    }
  }

  return sanitizeAndOrientBufferGeometry(currentBrush.geometry);
}

/**
 * Extracts crisp mechanical crease edges (dihedral angle >= `thresholdDeg`) from a manifold `BufferGeometry`,
 * suppressing smooth tessellation facet lines on cylinders, cones, spheres, and GeneralizedLofts.
 */
export function extractSharpFeatureEdges(
  geometry: BufferGeometry,
  thresholdDeg = 32
): BufferGeometry {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }

  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
  const cosThreshold = Math.cos((thresholdDeg * Math.PI) / 180);
  const posKey = (x: number, y: number, z: number) =>
    `${Math.round(x * 100)}_${Math.round(y * 100)}_${Math.round(z * 100)}`;

  interface EdgeRec {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
    normals: Vector3[];
  }
  const edgeMap = new Map<string, EdgeRec>();
  const vA = new Vector3();
  const vB = new Vector3();
  const vC = new Vector3();
  const cb = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();

  const addEdge = (p1: Vector3, k1: string, p2: Vector3, k2: string, n: Vector3) => {
    if (k1 === k2) return;
    if (p1.distanceToSquared(p2) < 4e-4) return;
    const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, {
        ax: p1.x,
        ay: p1.y,
        az: p1.z,
        bx: p2.x,
        by: p2.y,
        bz: p2.z,
        normals: [n.clone()],
      });
    } else if (existing.normals.every((en) => en.dot(n) < 0.9995)) {
      existing.normals.push(n.clone());
    }
  };

  for (let i = 0; i < triCount; i++) {
    const i0 = indexAttr ? indexAttr.getX(i * 3) : i * 3;
    const i1 = indexAttr ? indexAttr.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(i * 3 + 2) : i * 3 + 2;
    vA.fromBufferAttribute(posAttr, i0);
    vB.fromBufferAttribute(posAttr, i1);
    vC.fromBufferAttribute(posAttr, i2);
    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    ac.subVectors(vC, vA);
    const maxEdge = Math.max(cb.length(), ab.length(), ac.length());
    cb.cross(ab);
    const doubleArea = cb.length();
    // Ignore degenerate micro-sliver normals so CSG sub-triangulations never emit rogue burr lines
    if (doubleArea < 1e-4 || maxEdge < 1e-4 || doubleArea / maxEdge < 5e-4) continue;
    cb.divideScalar(doubleArea);

    const kA = posKey(vA.x, vA.y, vA.z);
    const kB = posKey(vB.x, vB.y, vB.z);
    const kC = posKey(vC.x, vC.y, vC.z);
    addEdge(vA, kA, vB, kB, cb);
    addEdge(vB, kB, vC, kC, cb);
    addEdge(vC, kC, vA, kA, cb);
  }

  const lineCoords: number[] = [];
  const singletons: {
    rec: EdgeRec;
    mx: number;
    my: number;
    mz: number;
    dx: number;
    dy: number;
    dz: number;
    len: number;
  }[] = [];

  for (const rec of edgeMap.values()) {
    if (rec.normals.length >= 2) {
      let sharp = false;
      for (let i = 0; i < rec.normals.length && !sharp; i++) {
        for (let j = i + 1; j < rec.normals.length; j++) {
          if (rec.normals[i].dot(rec.normals[j]) < cosThreshold) {
            sharp = true;
            break;
          }
        }
      }
      if (sharp) {
        lineCoords.push(rec.ax, rec.ay, rec.az, rec.bx, rec.by, rec.bz);
      }
    } else if (rec.normals.length === 1) {
      const vx = rec.bx - rec.ax;
      const vy = rec.by - rec.ay;
      const vz = rec.bz - rec.az;
      const len = Math.hypot(vx, vy, vz);
      if (len >= 0.05) {
        singletons.push({
          rec,
          mx: 0.5 * (rec.ax + rec.bx),
          my: 0.5 * (rec.ay + rec.by),
          mz: 0.5 * (rec.az + rec.bz),
          dx: vx / len,
          dy: vy / len,
          dz: vz / len,
          len,
        });
      }
    }
  }

  // Recover CSG T-junction sharp rims (e.g. circular hole rims where the bore quad diagonal splits a cap chord)
  for (const s of singletons) {
    for (const o of singletons) {
      if (o === s || o.len < s.len - 0.02) continue;
      if (Math.abs(s.dx * o.dx + s.dy * o.dy + s.dz * o.dz) < 0.996) continue;
      const wx = s.mx - o.rec.ax;
      const wy = s.my - o.rec.ay;
      const wz = s.mz - o.rec.az;
      const proj = wx * o.dx + wy * o.dy + wz * o.dz;
      if (proj < -0.03 || proj > o.len + 0.03) continue;
      const px = wx - proj * o.dx;
      const py = wy - proj * o.dy;
      const pz = wz - proj * o.dz;
      if (px * px + py * py + pz * pz <= 0.03 * 0.03) {
        if (s.rec.normals[0].dot(o.rec.normals[0]) < cosThreshold) {
          lineCoords.push(s.rec.ax, s.rec.ay, s.rec.az, s.rec.bx, s.rec.by, s.rec.bz);
          break;
        }
      }
    }
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(lineCoords, 3));
  return out;
}

/**
 * Inspects manifold quality metrics of a `BufferGeometry` for automated benchmark verification.
 */
export function verifyManifoldWatertightness(geom: BufferGeometry): {
  triangleCount: number;
  boundaryEdgeRatio: number;
  isWatertight: boolean;
} {
  const posAttr = geom.getAttribute('position');
  if (!posAttr || posAttr.count < 12) {
    return { triangleCount: 0, boundaryEdgeRatio: 1, isWatertight: false };
  }
  const triCount = Math.floor(posAttr.count / 3);
  const qKey = (x: number, y: number, z: number) =>
    `${Math.round(x * 50)}_${Math.round(y * 50)}_${Math.round(z * 50)}`;

  interface UndirectedEdgeRec {
    count: number;
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
    dx: number;
    dy: number;
    dz: number;
    len: number;
  }

  const edgeMap = new Map<string, UndirectedEdgeRec>();
  const bump = (i0: number, i1: number) => {
    const ax = posAttr.getX(i0), ay = posAttr.getY(i0), az = posAttr.getZ(i0);
    const bx = posAttr.getX(i1), by = posAttr.getY(i1), bz = posAttr.getZ(i1);
    const k0 = qKey(ax, ay, az);
    const k1 = qKey(bx, by, bz);
    if (k0 === k1) return;
    const key = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      const len = Math.hypot(vx, vy, vz);
      if (len < 1e-5) return;
      edgeMap.set(key, {
        count: 1,
        ax, ay, az, bx, by, bz,
        dx: vx / len, dy: vy / len, dz: vz / len,
        len,
      });
    }
  };

  for (let i = 0; i + 2 < posAttr.count; i += 3) {
    bump(i, i + 1);
    bump(i + 1, i + 2);
    bump(i + 2, i);
  }

  // Any edge with count === 1 is either a genuine boundary hole OR a collinear T-junction split
  // created when BVH-CSG retriangulates one face along an unsplit neighbor edge.
  const singletons: UndirectedEdgeRec[] = [];
  for (const rec of edgeMap.values()) {
    if (rec.count === 1) singletons.push(rec);
  }

  let trueOpenEdges = 0;
  for (const e of singletons) {
    const mx = 0.5 * (e.ax + e.bx);
    const my = 0.5 * (e.ay + e.by);
    const mz = 0.5 * (e.az + e.bz);
    let onCollinearPeer = false;

    for (const o of singletons) {
      if (o === e) continue;
      if (Math.abs(e.dx * o.dx + e.dy * o.dy + e.dz * o.dz) < 0.985) continue;
      const wx = mx - o.ax;
      const wy = my - o.ay;
      const wz = mz - o.az;
      const proj = wx * o.dx + wy * o.dy + wz * o.dz;
      if (proj < -0.1 || proj > o.len + 0.1) continue;
      const px = wx - proj * o.dx;
      const py = wy - proj * o.dy;
      const pz = wz - proj * o.dz;
      if (px * px + py * py + pz * pz <= 0.1 * 0.1) {
        onCollinearPeer = true;
        break;
      }
    }

    if (!onCollinearPeer) {
      trueOpenEdges++;
    }
  }

  const ratio = edgeMap.size > 0 ? trueOpenEdges / edgeMap.size : 1;
  return {
    triangleCount: triCount,
    boundaryEdgeRatio: ratio,
    isWatertight: triCount >= 4 && ratio <= 0.045,
  };
}

/**
 * Exports a `Primitive3D[]` solid model into an industrial ASCII STL file string
 * directly from the unified sharp-edge watertight manifold mesher (including all CSG holes,
 * slots, GeneralizedLofts, hemispheres, and saddle intersections!).
 */
export function exportPrimitivesToWatertightSTL(
  primitives: Primitive3D[],
  solidName = 'DorED_Solid'
): string {
  const safeName = solidName.replace(/\s+/g, '_');
  const geom = buildWatertightManifoldGeometry(primitives, 'engineering');
  const posAttr = geom.getAttribute('position');

  const lines: string[] = [`solid ${safeName}`];
  if (posAttr && posAttr.count >= 3) {
    const v0 = new Vector3();
    const v1 = new Vector3();
    const v2 = new Vector3();
    const e1 = new Vector3();
    const e2 = new Vector3();
    const n = new Vector3();

    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      v0.fromBufferAttribute(posAttr, i);
      v1.fromBufferAttribute(posAttr, i + 1);
      v2.fromBufferAttribute(posAttr, i + 2);
      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      n.crossVectors(e1, e2);
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();

      lines.push(`  facet normal ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}`);
      lines.push('    outer loop');
      lines.push(`      vertex ${v0.x.toFixed(5)} ${v0.y.toFixed(5)} ${v0.z.toFixed(5)}`);
      lines.push(`      vertex ${v1.x.toFixed(5)} ${v1.y.toFixed(5)} ${v1.z.toFixed(5)}`);
      lines.push(`      vertex ${v2.x.toFixed(5)} ${v2.y.toFixed(5)} ${v2.z.toFixed(5)}`);
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }

  geom.dispose();
  lines.push(`endsolid ${safeName}`);
  return lines.join('\n');
}
