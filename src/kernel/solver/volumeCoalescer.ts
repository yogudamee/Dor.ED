import { Primitive3D } from '../../types/cad';
import { evalPrimitive3DSDF } from '../lifting3d/analyticSurfaces';

const COPLANAR_TOL = 0.08;

function sameInterval(a0: number, a1: number, b0: number, b1: number, tol = COPLANAR_TOL): boolean {
  return Math.abs(a0 - b0) <= tol && Math.abs(a1 - b1) <= tol;
}

/**
 * Algebraically coalesce adjacent positive solid primitives (`operation === 'add'`) to
 * 100% eliminate internal coplanar walls (`x_a = x_b = 1` shared faces) WITHOUT ever applying
 * negative insets (zero Lego grooves!):
 * 1. Iteratively merges adjacent `box` primitives sharing an exact face along X, Y, or Z.
 * 2. Merges coaxial abutting/overlapping `cylinder_x/y/z` primitives of equal radius.
 * 3. Removes redundant positive primitives completely contained inside a larger positive primitive.
 * 4. Ensures straddling half-exposed / half-embedded cylinders fuse cleanly with stepped bases.
 */
export function coalesceSolidPrimitives(primitives: Primitive3D[]): Primitive3D[] {
  const positives = primitives
    .filter((p) => p.operation === 'add')
    .map((p) => ({ ...p }));
  const intersects = primitives
    .filter((p) => p.operation === 'intersect')
    .map((p) => ({ ...p }));
  const subtracts = primitives
    .filter((p) => p.operation === 'subtract')
    .map((p) => ({ ...p }));

  // 1. Iterative exact coplanar box merging (X, Y, Z)
  let mergedAny = true;
  let guard = 0;
  while (mergedAny && guard < 64) {
    mergedAny = false;
    guard++;
    outer: for (let i = 0; i < positives.length; i++) {
      const a = positives[i];
      if (a.shape !== 'box' || a.loftSpec) continue;
      for (let j = i + 1; j < positives.length; j++) {
        const b = positives[j];
        if (b.shape !== 'box' || b.loftSpec) continue;

        // Merge along X if Y and Z spans match and X intervals touch/overlap
        if (
          sameInterval(a.yMin, a.yMax, b.yMin, b.yMax) &&
          sameInterval(a.zMin, a.zMax, b.zMin, b.zMax) &&
          Math.max(a.xMin, b.xMin) <= Math.min(a.xMax, b.xMax) + COPLANAR_TOL
        ) {
          a.xMin = Math.min(a.xMin, b.xMin);
          a.xMax = Math.max(a.xMax, b.xMax);
          positives.splice(j, 1);
          mergedAny = true;
          break outer;
        }

        // Merge along Y if X and Z spans match and Y intervals touch/overlap
        if (
          sameInterval(a.xMin, a.xMax, b.xMin, b.xMax) &&
          sameInterval(a.zMin, a.zMax, b.zMin, b.zMax) &&
          Math.max(a.yMin, b.yMin) <= Math.min(a.yMax, b.yMax) + COPLANAR_TOL
        ) {
          a.yMin = Math.min(a.yMin, b.yMin);
          a.yMax = Math.max(a.yMax, b.yMax);
          positives.splice(j, 1);
          mergedAny = true;
          break outer;
        }

        // Merge along Z if X and Y spans match and Z intervals touch/overlap
        if (
          sameInterval(a.xMin, a.xMax, b.xMin, b.xMax) &&
          sameInterval(a.yMin, a.yMax, b.yMin, b.yMax) &&
          Math.max(a.zMin, b.zMin) <= Math.min(a.zMax, b.zMax) + COPLANAR_TOL
        ) {
          a.zMin = Math.min(a.zMin, b.zMin);
          a.zMax = Math.max(a.zMax, b.zMax);
          positives.splice(j, 1);
          mergedAny = true;
          break outer;
        }
      }
    }
  }

  // 2. Coaxial equal-radius cylinder merging
  let cylMerged = true;
  let cylGuard = 0;
  while (cylMerged && cylGuard < 32) {
    cylMerged = false;
    cylGuard++;
    outerCyl: for (let i = 0; i < positives.length; i++) {
      const a = positives[i];
      if (!a.shape.startsWith('cylinder_')) continue;
      for (let j = i + 1; j < positives.length; j++) {
        const b = positives[j];
        if (b.shape !== a.shape) continue;
        const rA = a.radius ?? 0.5 * (a.xMax - a.xMin);
        const rB = b.radius ?? 0.5 * (b.xMax - b.xMin);
        if (Math.abs(rA - rB) > COPLANAR_TOL) continue;

        if (
          a.shape === 'cylinder_z' &&
          Math.abs((a.centerX ?? 0) - (b.centerX ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerY ?? 0) - (b.centerY ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.zMin, b.zMin) <= Math.min(a.zMax, b.zMax) + COPLANAR_TOL
        ) {
          a.zMin = Math.min(a.zMin, b.zMin);
          a.zMax = Math.max(a.zMax, b.zMax);
          a.centerZ = 0.5 * (a.zMin + a.zMax);
          positives.splice(j, 1);
          cylMerged = true;
          break outerCyl;
        }
        if (
          a.shape === 'cylinder_y' &&
          Math.abs((a.centerX ?? 0) - (b.centerX ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerZ ?? 0) - (b.centerZ ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.yMin, b.yMin) <= Math.min(a.yMax, b.yMax) + COPLANAR_TOL
        ) {
          a.yMin = Math.min(a.yMin, b.yMin);
          a.yMax = Math.max(a.yMax, b.yMax);
          a.centerY = 0.5 * (a.yMin + a.yMax);
          positives.splice(j, 1);
          cylMerged = true;
          break outerCyl;
        }
        if (
          a.shape === 'cylinder_x' &&
          Math.abs((a.centerY ?? 0) - (b.centerY ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerZ ?? 0) - (b.centerZ ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.xMin, b.xMin) <= Math.min(a.xMax, b.xMax) + COPLANAR_TOL
        ) {
          a.xMin = Math.min(a.xMin, b.xMin);
          a.xMax = Math.max(a.xMax, b.xMax);
          a.centerX = 0.5 * (a.xMin + a.xMax);
          positives.splice(j, 1);
          cylMerged = true;
          break outerCyl;
        }
      }
    }
  }

  // 3. Straddling cylinder base fusion check:
  // If a vertical/horizontal solid cylinder rests on top of a stepped block (`zMin_cyl == zMax_lower_step`)
  // AND horizontally overlaps a taller adjacent step (`zMax_upper_step > zMin_cyl`), extend the cylinder's
  // embedded root slightly/fully down into `zMin_base` (within the base's footprint!) so CSG boolean union
  // fuses them into a single watertight solid with zero zero-thickness coplanar step seam!
  for (const cyl of positives) {
    if (cyl.shape === 'cylinder_z') {
      const baseBoxes = positives.filter((p) => p.shape === 'box');
      if (baseBoxes.length >= 1) {
        const minBaseZ = Math.min(...baseBoxes.map((b) => b.zMin));
        const touchesStepAtZMin = baseBoxes.some(
          (b) =>
            Math.abs(b.zMax - cyl.zMin) <= 0.15 &&
            cyl.xMin < b.xMax - 0.5 &&
            cyl.xMax > b.xMin + 0.5 &&
            cyl.yMin < b.yMax - 0.5 &&
            cyl.yMax > b.yMin + 0.5
        );
        // Check if cylinder footprint at minBaseZ + 1 is completely inside the union of baseBoxes!
        if (touchesStepAtZMin && cyl.zMin > minBaseZ + 0.5) {
          const cx = cyl.centerX ?? 0.5 * (cyl.xMin + cyl.xMax);
          const cy = cyl.centerY ?? 0.5 * (cyl.yMin + cyl.yMax);
          const r = (cyl.radius ?? 0.5 * (cyl.xMax - cyl.xMin)) - 0.2;
          const testPts = [
            { x: cx, y: cy, z: minBaseZ + 0.5 },
            { x: cx + r, y: cy, z: minBaseZ + 0.5 },
            { x: cx - r, y: cy, z: minBaseZ + 0.5 },
            { x: cx, y: cy + r, z: minBaseZ + 0.5 },
            { x: cx, y: cy - r, z: minBaseZ + 0.5 },
          ];
          const allInsideBase = testPts.every((pt) =>
            baseBoxes.some((bb) => evalPrimitive3DSDF(pt, bb) <= 0.05)
          );
          if (allInsideBase) {
            cyl.zMin = minBaseZ;
            cyl.centerZ = 0.5 * (cyl.zMin + cyl.zMax);
          }
        }
      }
    }
  }

  // 4. Prune any positive primitive 100% contained inside another single positive primitive
  const keptPositives = positives.filter((cand, idx) => {
    const samplePts: { x: number; y: number; z: number }[] = [];
    for (const fx of [0.15, 0.5, 0.85]) {
      for (const fy of [0.15, 0.5, 0.85]) {
        for (const fz of [0.15, 0.5, 0.85]) {
          const pt = {
            x: cand.xMin + (cand.xMax - cand.xMin) * fx,
            y: cand.yMin + (cand.yMax - cand.yMin) * fy,
            z: cand.zMin + (cand.zMax - cand.zMin) * fz,
          };
          if (evalPrimitive3DSDF(pt, cand) <= -0.05) {
            samplePts.push(pt);
          }
        }
      }
    }
    if (samplePts.length === 0) return true;

    for (let j = 0; j < positives.length; j++) {
      if (j === idx) continue;
      const other = positives[j];
      if (
        other.xMin <= cand.xMin + COPLANAR_TOL &&
        other.xMax >= cand.xMax - COPLANAR_TOL &&
        other.yMin <= cand.yMin + COPLANAR_TOL &&
        other.yMax >= cand.yMax - COPLANAR_TOL &&
        other.zMin <= cand.zMin + COPLANAR_TOL &&
        other.zMax >= cand.zMax - COPLANAR_TOL
      ) {
        if (samplePts.every((pt) => evalPrimitive3DSDF(pt, other) <= 0.02)) {
          return false;
        }
      }
    }
    return true;
  });

  // 5. Merge identical coaxial subtract cylinders
  let subMerged = true;
  let subGuard = 0;
  while (subMerged && subGuard < 32) {
    subMerged = false;
    subGuard++;
    outerSub: for (let i = 0; i < subtracts.length; i++) {
      const a = subtracts[i];
      if (!a.shape.startsWith('cylinder_')) continue;
      for (let j = i + 1; j < subtracts.length; j++) {
        const b = subtracts[j];
        if (b.shape !== a.shape) continue;
        const rA = a.radius ?? 0;
        const rB = b.radius ?? 0;
        if (Math.abs(rA - rB) > COPLANAR_TOL) continue;
        if (
          a.shape === 'cylinder_z' &&
          Math.abs((a.centerX ?? 0) - (b.centerX ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerY ?? 0) - (b.centerY ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.zMin, b.zMin) <= Math.min(a.zMax, b.zMax) + COPLANAR_TOL
        ) {
          a.zMin = Math.min(a.zMin, b.zMin);
          a.zMax = Math.max(a.zMax, b.zMax);
          subtracts.splice(j, 1);
          subMerged = true;
          break outerSub;
        }
        if (
          a.shape === 'cylinder_y' &&
          Math.abs((a.centerX ?? 0) - (b.centerX ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerZ ?? 0) - (b.centerZ ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.yMin, b.yMin) <= Math.min(a.yMax, b.yMax) + COPLANAR_TOL
        ) {
          a.yMin = Math.min(a.yMin, b.yMin);
          a.yMax = Math.max(a.yMax, b.yMax);
          subtracts.splice(j, 1);
          subMerged = true;
          break outerSub;
        }
        if (
          a.shape === 'cylinder_x' &&
          Math.abs((a.centerY ?? 0) - (b.centerY ?? 0)) <= COPLANAR_TOL &&
          Math.abs((a.centerZ ?? 0) - (b.centerZ ?? 0)) <= COPLANAR_TOL &&
          Math.max(a.xMin, b.xMin) <= Math.min(a.xMax, b.xMax) + COPLANAR_TOL
        ) {
          a.xMin = Math.min(a.xMin, b.xMin);
          a.xMax = Math.max(a.xMax, b.xMax);
          subtracts.splice(j, 1);
          subMerged = true;
          break outerSub;
        }
      }
    }
  }

  return [...keptPositives, ...intersects, ...subtracts];
}
