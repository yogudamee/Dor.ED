/**
 * Low-Level 3D Analytical SDF & CSG Projection Library (csgPrimitives.ts)
 */
import {
  CadArcEntity,
  CadCircleEntity,
  CadEntity,
  CadLineEntity,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ViewType,
} from "../types/cad";
import {
  primitiveToGeneralizedLoft,
  extractGeneralizedLoftEdgesAndSilhouettes,
  extractSlantedPlanesFromPrimitive,
  computePlaneQuadricSectionSegments,
} from "../kernel";

export function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

export function isAngleOnArc(a: number, start: number, end: number, tol = 0.001): boolean {
  const na = normalizeAngle(a);
  const ns = normalizeAngle(start);
  const span = normalizeAngle(normalizeAngle(end) - ns);
  const rel = normalizeAngle(na - ns);
  return rel <= span + tol || rel >= Math.PI * 2 - tol;
}

export function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D) {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return { dist: dist2D(p, a), proj: a, t: 0 };
  let t = ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const proj = { u: a.u + t * dx, v: a.v + t * dy };
  return { dist: dist2D(p, proj), proj, t };
}

export function polygonArea2D(poly) {
	let area = 0;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j].u + poly[i].u) * (poly[j].v - poly[i].v);
	return Math.abs(area) * .5;
}
export function pointInPolygon2D(pt, poly) {
	let wn = 0;
	for (let i = 0; i < poly.length; i++) {
		const p1 = poly[i];
		const p2 = poly[(i + 1) % poly.length];
		if (p1.v <= pt.v) {
			if (p2.v > pt.v) {
				if ((p2.u - p1.u) * (pt.v - p1.v) - (pt.u - p1.u) * (p2.v - p1.v) > 0) wn++;
			}
		} else if (p2.v <= pt.v) {
			if ((p2.u - p1.u) * (pt.v - p1.v) - (pt.u - p1.u) * (p2.v - p1.v) < 0) wn--;
		}
	}
	return wn !== 0;
}
/**
 * Layer 1 Homologous Arc Sampler:
 * Samples an arc using the exact same counter-clockwise parameter formula (startAngle -> endAngle)
 * as 2D Canvas/SVG rendering (expandEntityToSegments). Never inverts the arc trajectory!
 */
export function sampleArcPoints(
	arc: { center: Point2D; radius: number; startAngle: number; endAngle: number },
	numSegments = 48
): Point2D[] {
	const n = Math.max(8, numSegments);
	let span = normalizeAngle(arc.endAngle - arc.startAngle);
	if (span <= 1e-4) span = Math.PI * 2;
	const pts: Point2D[] = [];
	for (let k = 0; k <= n; k++) {
		const ang = arc.startAngle + (k / n) * span;
		pts.push({
			u: arc.center.u + arc.radius * Math.cos(ang),
			v: arc.center.v + arc.radius * Math.sin(ang)
		});
	}
	return pts;
}

/**
 * Chains line and arc segments strictly head-to-tail into a non-self-intersecting dense 2D polygon
 * using canonical arc coordinates from sampleArcPoints.
 */
export function chainSegmentsIntoDensePolygon(
	segments?: LoopCurveSegment2D[],
	fallbackPoly?: Point2D[],
	numArcSegments = 48
): Point2D[] {
	if (!segments || segments.length === 0) return fallbackPoly || [];
	const items = segments
		.map((seg) => {
			if (
				seg.kind === "arc" &&
				seg.center &&
				seg.radius !== void 0 &&
				seg.startAngle !== void 0 &&
				seg.endAngle !== void 0
			) {
				const forwardPts = sampleArcPoints(
					{
						center: seg.center,
						radius: seg.radius,
						startAngle: seg.startAngle,
						endAngle: seg.endAngle
					},
					numArcSegments
				);
				return {
					forwardPts,
					startPt: forwardPts[0],
					endPt: forwardPts[forwardPts.length - 1]
				};
			}
			const p1 = seg.p1;
			const p2 = seg.p2;
			if (!p1 || !p2) return null;
			return {
				forwardPts: [p1, p2],
				startPt: p1,
				endPt: p2
			};
		})
		.filter((it): it is { forwardPts: Point2D[]; startPt: Point2D; endPt: Point2D } => it !== null);

	if (items.length === 0) return fallbackPoly || [];

	const used = new Array(items.length).fill(false);
	const dense: Point2D[] = [];
	const pushPts = (pts: Point2D[]) => {
		for (const p of pts) {
			if (dense.length === 0 || dist2D(dense[dense.length - 1], p) > 1e-3) {
				dense.push({ u: p.u, v: p.v });
			}
		}
	};

	used[0] = true;
	let firstForward = true;
	if (items.length >= 2) {
		const dEndToNext = Math.min(
			...items.slice(1).map((it) => Math.min(dist2D(items[0].endPt, it.startPt), dist2D(items[0].endPt, it.endPt)))
		);
		const dStartToNext = Math.min(
			...items.slice(1).map((it) => Math.min(dist2D(items[0].startPt, it.startPt), dist2D(items[0].startPt, it.endPt)))
		);
		if (dStartToNext + 1e-3 < dEndToNext) {
			firstForward = false;
		}
	}
	if (firstForward) {
		pushPts(items[0].forwardPts);
	} else {
		pushPts([...items[0].forwardPts].reverse());
	}

	for (let step = 1; step < items.length; step++) {
		const currPt = dense[dense.length - 1];
		let bestIdx = -1;
		let bestReverse = false;
		let bestDist = Infinity;
		for (let i = 0; i < items.length; i++) {
			if (used[i]) continue;
			const dStart = dist2D(currPt, items[i].startPt);
			const dEnd = dist2D(currPt, items[i].endPt);
			if (dStart < bestDist) {
				bestDist = dStart;
				bestIdx = i;
				bestReverse = false;
			}
			if (dEnd < bestDist) {
				bestDist = dEnd;
				bestIdx = i;
				bestReverse = true;
			}
		}
		if (bestIdx === -1) break;
		used[bestIdx] = true;
		const chosen = items[bestIdx];
		pushPts(bestReverse ? [...chosen.forwardPts].reverse() : chosen.forwardPts);
	}

	if (dense.length > 2 && dist2D(dense[0], dense[dense.length - 1]) <= 1e-2) {
		dense.pop();
	}
	return dense.length >= 3 ? dense : fallbackPoly || [];
}

/**
* Exact 2D Signed Distance Function for arbitrary closed polygon / curved loop (with analytical circular arcs):
* Negative inside, positive outside, 0 on boundary.
*/
export function curvedLoopSignedDist2D(pt, poly, segments) {
	if ((!poly || poly.length < 3) && (!segments || segments.length === 0)) return 1e6;
	if (segments && segments.length > 0) {
		const hasArc = segments.some((s) => s.kind === "arc");
		const evalPoly = hasArc && (!poly || poly.length < 16) ? chainSegmentsIntoDensePolygon(segments, poly, 36) : poly;
		if (!evalPoly || evalPoly.length < 3) return 1e6;
		let minDist = Infinity;
		let closestArcOnSpan = null;
		for (const seg of segments) if (seg.kind === "arc" && seg.center && seg.radius !== void 0 && seg.startAngle !== void 0 && seg.endAngle !== void 0) {
			if (isAngleOnArc(Math.atan2(pt.v - seg.center.v, pt.u - seg.center.u), seg.startAngle, seg.endAngle, 1e-4)) {
				const rPt = Math.hypot(pt.u - seg.center.u, pt.v - seg.center.v);
				const d = Math.abs(rPt - seg.radius);
				if (d < minDist) {
					minDist = d;
					closestArcOnSpan = seg;
				}
			} else {
				const d = Math.min(dist2D(pt, seg.p1), dist2D(pt, seg.p2));
				if (d < minDist) {
					minDist = d;
					closestArcOnSpan = null;
				}
			}
		} else {
			const d = pointToSegmentDist(pt, seg.p1, seg.p2).dist;
			if (d < minDist) {
				minDist = d;
				closestArcOnSpan = null;
			}
		}
		let inside = pointInPolygon2D(pt, evalPoly);
		if (closestArcOnSpan && minDist < 1.2 && closestArcOnSpan.center && closestArcOnSpan.radius !== void 0 && closestArcOnSpan.startAngle !== void 0 && closestArcOnSpan.endAngle !== void 0) {
			const span = normalizeAngle(closestArcOnSpan.endAngle - closestArcOnSpan.startAngle);
			const midAng = closestArcOnSpan.startAngle + .5 * span;
			const probeOffset = Math.min(2.0, Math.max(0.4, closestArcOnSpan.radius * 0.25));
			const rProbeIn = Math.max(0.1, closestArcOnSpan.radius - probeOffset);
			const rProbeOut = closestArcOnSpan.radius + probeOffset;
			const inSideInside = pointInPolygon2D({
				u: closestArcOnSpan.center.u + rProbeIn * Math.cos(midAng),
				v: closestArcOnSpan.center.v + rProbeIn * Math.sin(midAng)
			}, evalPoly);
			const outSideInside = pointInPolygon2D({
				u: closestArcOnSpan.center.u + rProbeOut * Math.cos(midAng),
				v: closestArcOnSpan.center.v + rProbeOut * Math.sin(midAng)
			}, evalPoly);
			const rPt = Math.hypot(pt.u - closestArcOnSpan.center.u, pt.v - closestArcOnSpan.center.v);
			if (inSideInside && !outSideInside) {
				inside = rPt < closestArcOnSpan.radius;
			} else if (!inSideInside && outSideInside) {
				inside = rPt > closestArcOnSpan.radius;
			}
		}
		return inside ? -minDist : minDist;
	}
	let minDist = Infinity;
	for (let i = 0; i < poly.length; i++) {
		const p1 = poly[i];
		const p2 = poly[(i + 1) % poly.length];
		const d = pointToSegmentDist(pt, p1, p2).dist;
		if (d < minDist) minDist = d;
	}
	return pointInPolygon2D(pt, poly) ? -minDist : minDist;
}
export function isValidPrimitive3D(prim: any): boolean {
	if (!prim) return false;
	if (!Number.isFinite(prim.xMin) || !Number.isFinite(prim.xMax) || !Number.isFinite(prim.yMin) || !Number.isFinite(prim.yMax) || !Number.isFinite(prim.zMin) || !Number.isFinite(prim.zMax)) return false;
	if (prim.xMax - prim.xMin <= 1e-3 || prim.yMax - prim.yMin <= 1e-3 || prim.zMax - prim.zMin <= 1e-3) return false;
	if (prim.shape === "cylinder_z" || prim.shape === "cylinder_y" || prim.shape === "cylinder_x" || prim.shape === "sphere" || prim.shape === "hemisphere") {
		if (prim.radius !== void 0 && (!Number.isFinite(prim.radius) || prim.radius <= 1e-3)) return false;
	}
	if (prim.shape === "prism" || prim.shape === "pyramid") {
		if (!prim.prismPolygon || prim.prismPolygon.length < 3) return false;
		for (const pt of prim.prismPolygon) if (!pt || !Number.isFinite(pt.u) || !Number.isFinite(pt.v)) return false;
	}
	return true;
}

export function isFullBaseSubtract(sub: any, base: any): boolean {
	if (!sub || !base || sub.operation !== "subtract") return false;
	if (sub.shape !== "box" && sub.shape !== "prism") return false;
	const coversX = sub.xMin <= base.xMin + 1.5 && sub.xMax >= base.xMax - 1.5;
	const coversY = sub.yMin <= base.yMin + 1.5 && sub.yMax >= base.yMax - 1.5;
	const coversZ = sub.zMin <= base.zMin + 1.5 && sub.zMax >= base.zMax - 1.5;
	if (coversX && coversY && coversZ) {
		if (sub.shape === "box") return true;
		if (sub.shape === "prism" && sub.prismPolygon) {
			const area = polygonArea2D(sub.prismPolygon);
			const axis = sub.prismAxis || "Y";
			const refArea = axis === "Y" ? (base.xMax - base.xMin) * (base.zMax - base.zMin) : axis === "Z" ? (base.xMax - base.xMin) * (base.yMax - base.yMin) : (base.yMax - base.yMin) * (base.zMax - base.zMin);
			if (area >= 0.92 * refArea) return true;
		}
	}
	return false;
}

/**
* Exact 3D Signed Distance Function for Box, Cylinder (X/Y/Z), and Arbitrary Extruded Polygon/Curved Prism
*/
export function evalPrimitiveSDF(p, prim) {
	if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || !isValidPrimitive3D(prim)) return 1e6;
	const xc = .5 * (prim.xMin + prim.xMax);
	const yc = .5 * (prim.yMin + prim.yMax);
	const zc = .5 * (prim.zMin + prim.zMax);
	const hx = .5 * (prim.xMax - prim.xMin);
	const hy = .5 * (prim.yMax - prim.yMin);
	const hz = .5 * (prim.zMax - prim.zMin);
	let res = 1e6;
	if (prim.shape === "sphere") {
		const r = prim.radius ?? Math.min(hx, hy, hz);
		const cx = prim.centerX ?? xc;
		const cy = prim.centerY ?? yc;
		const cz = prim.centerZ ?? zc;
		res = Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;
	} else if (prim.shape === "hemisphere") {
		const r = prim.radius ?? Math.max(hx, hy, hz);
		const cx = prim.centerX ?? xc;
		const cy = prim.centerY ?? yc;
		const cz = prim.centerZ ?? prim.zMin;
		const dSphere = Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;
		const xLo = Math.abs(cx - prim.xMin) <= 3.5 && prim.xMax > cx + 3.5 ? cx : prim.xMin;
		const xHi = Math.abs(cx - prim.xMax) <= 3.5 && prim.xMin < cx - 3.5 ? cx : prim.xMax;
		const yLo = Math.abs(cy - prim.yMin) <= 3.5 && prim.yMax > cy + 3.5 ? cy : prim.yMin;
		const yHi = Math.abs(cy - prim.yMax) <= 3.5 && prim.yMin < cy - 3.5 ? cy : prim.yMax;
		const zLo = Math.abs(cz - prim.zMin) <= 3.5 && prim.zMax > cz + 3.5 ? cz : prim.zMin;
		const zHi = Math.abs(cz - prim.zMax) <= 3.5 && prim.zMin < cz - 3.5 ? cz : prim.zMax;
		const dBox = Math.max(xLo - p.x, p.x - xHi, yLo - p.y, p.y - yHi, zLo - p.z, p.z - zHi);
		res = Math.max(dSphere, dBox);
	} else if (prim.shape === "cone_z" || prim.shape === "cone_y" || prim.shape === "cone_x") {
		const r0 = prim.rMin ?? prim.radius ?? Math.min(hx, hy);
		const r1 = prim.rMax ?? 0;
		const isZ = prim.shape === "cone_z";
		const isY = prim.shape === "cone_y";
		const uVal = isZ ? p.x : isY ? p.x : p.y;
		const vVal = isZ ? p.y : isY ? p.z : p.z;
		const wVal = isZ ? p.z : isY ? p.y : p.x;
		const uC = isZ ? prim.centerX ?? xc : isY ? prim.centerX ?? xc : prim.centerY ?? yc;
		const vC = isZ ? prim.centerY ?? yc : isY ? prim.centerZ ?? zc : prim.centerZ ?? zc;
		const uCMin = (prim as any).uCenterMin ?? uC;
		const uCMax = (prim as any).uCenterMax ?? uC;
		const vCMin = (prim as any).vCenterMin ?? vC;
		const vCMax = (prim as any).vCenterMax ?? vC;
		const wMin = isZ ? prim.zMin : isY ? prim.yMin : prim.xMin;
		const wMax = isZ ? prim.zMax : isY ? prim.yMax : prim.xMax;
		const hW = Math.max(.5, .5 * (wMax - wMin));
		const wC = .5 * (wMin + wMax);
		const t = Math.max(0, Math.min(1, (wVal - wMin) / Math.max(.001, wMax - wMin)));
		const uCAtT = (1 - t) * uCMin + t * uCMax;
		const vCAtT = (1 - t) * vCMin + t * vCMax;
		const rAtT = (1 - t) * r0 + t * r1;
		const cosAlpha = (wMax - wMin) / Math.hypot(wMax - wMin, r0 - r1);
		const dLat = (Math.hypot(uVal - uCAtT, vVal - vCAtT) - rAtT) * cosAlpha;
		const dW = Math.abs(wVal - wC) - (hW + (prim.operation === "subtract" ? 1.2 : 0));
		res = Math.max(dLat, dW);
	} else if (prim.shape === "pyramid" && prim.prismPolygon && prim.prismPolygon.length >= 3 && prim.apex3D) {
		const axis = prim.prismAxis || "Z";
		const [ax, ay, az] = prim.apex3D;
		const uVal = axis === "Z" ? p.x : axis === "Y" ? p.x : p.y;
		const vVal = axis === "Z" ? p.y : axis === "Y" ? p.z : p.z;
		const wVal = axis === "Z" ? p.z : axis === "Y" ? p.y : p.x;
		const uApex = axis === "Z" ? ax : axis === "Y" ? ax : ay;
		const vApex = axis === "Z" ? ay : axis === "Y" ? az : az;
		const wApex = axis === "Z" ? az : axis === "Y" ? ay : ax;
		const wMin = axis === "Z" ? prim.zMin : axis === "Y" ? prim.yMin : prim.xMin;
		const wMax = axis === "Z" ? prim.zMax : axis === "Y" ? prim.yMax : prim.xMax;
		const wBase = Math.abs(wApex - wMin) > Math.abs(wApex - wMax) ? wMin : wMax;
		const spanW = wApex - wBase;
		const topScale = typeof prim.pyramidTopScale === "number" && prim.pyramidTopScale > 1e-3 ? prim.pyramidTopScale : 0;
		const t = Math.max(0, Math.min(.995, (wVal - wBase) / (Math.abs(spanW) > .001 ? spanW : 1)));
		const scale = Math.max(.005, 1 - t * (1 - topScale));
		const d2d = curvedLoopSignedDist2D({
			u: uApex + (uVal - uApex) / scale,
			v: vApex + (vVal - vApex) / scale
		}, prim.prismPolygon, prim.prismSegments) * scale;
		const dW = Math.abs(wVal - .5 * (wMin + wMax)) - (.5 * (wMax - wMin) + (prim.operation === "subtract" ? 1.2 : 0));
		res = Math.max(d2d, dW);
	} else if (prim.shape === "plane_sheet" && prim.vertices3D && prim.vertices3D.length >= 3) {
		const dx = Math.abs(p.x - xc) - hx;
		const dy = Math.abs(p.y - yc) - hy;
		const dz = Math.abs(p.z - zc) - hz;
		res = Math.max(dx, dy, dz);
	} else if (prim.shape === "cylinder_z" && prim.radius !== void 0) {
		const cx = prim.centerX ?? xc;
		const cy = prim.centerY ?? yc;
		const dRad = Math.hypot(p.x - cx, p.y - cy) - prim.radius;
		const dZ = Math.abs(p.z - zc) - hz;
		res = Math.max(dRad, dZ);
	} else if (prim.shape === "cylinder_y" && prim.radius !== void 0) {
		const cx = prim.centerX ?? xc;
		const cz = prim.centerZ ?? zc;
		const dRad = Math.hypot(p.x - cx, p.z - cz) - prim.radius;
		const dY = Math.abs(p.y - yc) - hy;
		res = Math.max(dRad, dY);
	} else if (prim.shape === "cylinder_x" && prim.radius !== void 0) {
		const cy = prim.centerY ?? yc;
		const cz = prim.centerZ ?? zc;
		const dRad = Math.hypot(p.y - cy, p.z - cz) - prim.radius;
		const dX = Math.abs(p.x - xc) - hx;
		res = Math.max(dRad, dX);
	} else if (prim.shape === "prism" && prim.prismPolygon && prim.prismPolygon.length >= 3) {
		const axis = prim.prismAxis || "Y";
		if (axis === "Y") {
			const d2d = curvedLoopSignedDist2D({
				u: p.x,
				v: p.z
			}, prim.prismPolygon, prim.prismSegments);
			const dW = Math.abs(p.y - yc) - hy;
			res = Math.max(d2d, dW);
		} else if (axis === "Z") {
			const d2d = curvedLoopSignedDist2D({
				u: p.x,
				v: p.y
			}, prim.prismPolygon, prim.prismSegments);
			const dW = Math.abs(p.z - zc) - hz;
			res = Math.max(d2d, dW);
		} else {
			const d2d = curvedLoopSignedDist2D({
				u: p.y,
				v: p.z
			}, prim.prismPolygon, prim.prismSegments);
			const dW = Math.abs(p.x - xc) - hx;
			res = Math.max(d2d, dW);
		}
	} else {
		const dx = Math.abs(p.x - xc) - hx;
		const dy = Math.abs(p.y - yc) - hy;
		const dz = Math.abs(p.z - zc) - hz;
		res = Math.max(dx, dy, dz);
	}
	return Number.isFinite(res) ? res : 1e6;
}
/**
* Evaluate combined CSG SDF at point P:
* - Base solid is the INTERSECTION (max) of the base extrusions from each known view.
* - Boss solids are UNIONED (min) with the base solid.
* - Subtract solids are SUBTRACTED (max with -sdf_sub).
*/
export function evalCSGSDF(p, baseExtrusions, bossSolids, subSolids) {
	const validBases = baseExtrusions.filter(isValidPrimitive3D);
	let sdfBase = validBases.length > 0 ? evalPrimitiveSDF(p, validBases[0]) : 1e6;
	for (let i = 1; i < validBases.length; i++) {
		const b = validBases[i];
		const d = evalPrimitiveSDF(p, b);
		if (!Number.isFinite(d) || d >= 1e5) continue;
		if (b.operation === "intersect") {
			if (d > sdfBase) sdfBase = d;
		} else if (d < sdfBase) sdfBase = d;
	}
	let sdfAdd = sdfBase;
	for (const boss of bossSolids) {
		if (!isValidPrimitive3D(boss)) continue;
		const d = evalPrimitiveSDF(p, boss);
		if (!Number.isFinite(d) || d >= 1e5) continue;
		if (d < sdfAdd) sdfAdd = d;
	}
	let sdfCSG = sdfAdd;
	const refBase = validBases[0];
	for (const sub of subSolids) {
		if (!isValidPrimitive3D(sub)) continue;
		if (refBase && isFullBaseSubtract(sub, refBase)) continue;
		const rawD = evalPrimitiveSDF(p, sub);
		if (!Number.isFinite(rawD) || rawD >= 1e5) continue;
		const d = -rawD;
		if (d > sdfCSG) sdfCSG = d;
	}
	return {
		sdfAdd,
		sdfCSG
	};
}
/**
* Step A: Exact SDF Surface Survival + 26-Neighbor Real Material Transition Verification
*/
export function isPointOnRealCSGSurface(p, ownerType, ownerId, baseExtrusions, bossSolids, subSolids, secondOwnerId?: any) {
	if (ownerType === "add") {
		for (const base of baseExtrusions) {
			if (base.shape === "cone_z" || base.shape === "cone_y" || base.shape === "cone_x") {
				const isZ = base.shape === "cone_z";
				const isY = base.shape === "cone_y";
				const xc = base.centerX ?? .5 * (base.xMin + base.xMax);
				const yc = base.centerY ?? .5 * (base.yMin + base.yMax);
				const zc = base.centerZ ?? .5 * (base.zMin + base.zMax);
				const r0 = base.rMin ?? base.radius ?? 0;
				const r1 = base.rMax ?? 0;
				const wVal = isZ ? p.z : isY ? p.y : p.x;
				const wMin = isZ ? base.zMin : isY ? base.yMin : base.xMin;
				const wMax = isZ ? base.zMax : isY ? base.yMax : base.xMax;
				const radDist = isZ ? Math.hypot(p.x - xc, p.y - yc) : isY ? Math.hypot(p.x - xc, p.z - zc) : Math.hypot(p.y - yc, p.z - zc);
				const onMinRim = r0 > .5 && Math.abs(wVal - wMin) <= .25 && Math.abs(radDist - r0) <= .35;
				const onMaxRim = r1 > .5 && Math.abs(wVal - wMax) <= .25 && Math.abs(radDist - r1) <= .35;
				if (onMinRim || onMaxRim) {
					const rCap = onMinRim ? r0 : r1;
					const cylShape = isZ ? "cylinder_z" : isY ? "cylinder_y" : "cylinder_x";
					let cutByOther = false;
					let hasMatchingCoaxialHole = false;
					for (const sub of subSolids) {
						if (!isValidPrimitive3D(sub)) continue;
						const subU = isZ ? sub.centerX ?? .5 * (sub.xMin + sub.xMax) : isY ? sub.centerX ?? .5 * (sub.xMin + sub.xMax) : sub.centerY ?? .5 * (sub.yMin + sub.yMax);
						const subV = isZ ? sub.centerY ?? .5 * (sub.yMin + sub.yMax) : isY ? sub.centerZ ?? .5 * (sub.zMin + sub.zMax) : sub.centerZ ?? .5 * (sub.zMin + sub.zMax);
						const baseU = isZ ? xc : isY ? xc : yc;
						const baseV = isZ ? yc : isY ? zc : zc;
						const isCoaxialEqHole = sub.shape === cylShape && Math.hypot(subU - baseU, subV - baseV) <= 1.5 && Math.abs((sub.radius ?? 0) - rCap) <= 1.2;
						if (isCoaxialEqHole) {
							hasMatchingCoaxialHole = true;
							continue;
						}
						if (evalPrimitiveSDF(p, sub) < -.06) {
							cutByOther = true;
							break;
						}
					}
					if (hasMatchingCoaxialHole && !cutByOther) return true;
				}
			}
		}
	}
	const { sdfAdd, sdfCSG } = evalCSGSDF(p, baseExtrusions, bossSolids, subSolids);
	if (Math.abs(sdfCSG) > .14) return false;
	if (ownerType === "add") {
		for (const sub of subSolids) if (evalPrimitiveSDF(p, sub) < -.05) return false;
		const addBases = baseExtrusions.filter((b) => b.operation === "add");
		if (addBases.length > 1 && ownerId !== "base_solid") {
			for (const otherBase of addBases) {
				if (otherBase.id !== ownerId && otherBase.id !== secondOwnerId && evalPrimitiveSDF(p, otherBase) < -.05) return false;
			}
		}
		if (bossSolids.length > 0) {
			const sdfBase = evalCSGSDF(p, baseExtrusions, [], []).sdfAdd;
			if (ownerId === "base_solid") {
				for (const boss of bossSolids) if (boss.id !== secondOwnerId && evalPrimitiveSDF(p, boss) < -.05) return false;
			} else {
				if (secondOwnerId !== "base_solid" && sdfBase < -.05) return false;
				for (const boss of bossSolids) if (boss.id !== ownerId && boss.id !== secondOwnerId && evalPrimitiveSDF(p, boss) < -.05) return false;
			}
		}
	} else {
		if (sdfAdd > .12) return false;
		const ownerSub = subSolids.find((s) => s.id === ownerId);
		if (ownerSub && Math.abs(evalPrimitiveSDF(p, ownerSub)) > .16) return false;
		if (secondOwnerId) {
			const secondSub = subSolids.find((s) => s.id === secondOwnerId);
			if (secondSub && Math.abs(evalPrimitiveSDF(p, secondSub)) > .16) return false;
		}
		for (const sub of subSolids) if (sub.id !== ownerId && sub.id !== secondOwnerId && evalPrimitiveSDF(p, sub) < -.05) return false;
	}
	const r = .08;
	let hasSolidInterior = false;
	let hasAirExterior = false;
	for (const dx of [
		-.08,
		0,
		r
	]) for (const dy of [
		-.08,
		0,
		r
	]) for (const dz of [
		-.08,
		0,
		r
	]) {
		if (dx === 0 && dy === 0 && dz === 0) continue;
		const { sdfCSG: qSdf } = evalCSGSDF({
			x: p.x + dx,
			y: p.y + dy,
			z: p.z + dz
		}, baseExtrusions, bossSolids, subSolids);
		if (qSdf < -.005) hasSolidInterior = true;
		if (qSdf > .005) hasAirExterior = true;
		if (hasSolidInterior && hasAirExterior) return true;
	}
	if (hasAirExterior && !hasSolidInterior) {
		for (const dx of [-.24, 0, .24]) for (const dy of [-.24, 0, .24]) for (const dz of [-.24, 0, .24]) {
			if (dx === 0 && dy === 0 && dz === 0) continue;
			const { sdfCSG: qSdf } = evalCSGSDF({
				x: p.x + dx,
				y: p.y + dy,
				z: p.z + dz
			}, baseExtrusions, bossSolids, subSolids);
			if (qSdf < -.003) return true;
		}
	}
	return false;
}
/**
* Step B: Fine-Step (0.15mm) Sightline Raycast Strict-Interior Occlusion Test
* Sightline vectors toward camera (First-Angle Projection):
* - Front View (X-Z, front surface at Y_min): d_to_eye = (0, -1, 0)
* - Top View   (X-Y, top surface at Z_max):   d_to_eye = (0, 0, +1)
* - Left View  (Y-Z, left surface at X_min):  d_to_eye = (-1, 0, 0)
*/
export function isPointOccludedInView(p, view, bounds, baseExtrusions, bossSolids, subSolids) {
	const dir = view === "front" ? {
		x: 0,
		y: -1,
		z: 0
	} : view === "top" ? {
		x: 0,
		y: 0,
		z: 1
	} : {
		x: -1,
		y: 0,
		z: 0
	};
	const maxDist = view === "front" ? p.y - bounds.yMin + 2 : view === "top" ? bounds.zMax - p.z + 2 : p.x - bounds.xMin + 2;
	if (maxDist <= .12) return false;
	let s = .12;
	while (s <= maxDist) {
		const { sdfCSG } = evalCSGSDF({
			x: p.x + dir.x * s,
			y: p.y + dir.y * s,
			z: p.z + dir.z * s
		}, baseExtrusions, bossSolids, subSolids);
		if (sdfCSG < -.05) return true;
		const step = sdfCSG > .2 ? Math.max(.15, sdfCSG * .85) : .15;
		s += step;
	}
	return false;
}
export function projectPoint3DToView(p, view) {
	if (view === "front") return {
		u: p.x,
		v: p.z
	};
	if (view === "top") return {
		u: p.x,
		v: p.y
	};
	return {
		u: p.y,
		v: p.z
	};
}
/**
* Generate all 3D candidate linear edges, circular edges, and 3D space intersection curves for a CSG solid
* Strictly adheres to GB/T 4458.1:
* - Never emits intermediate discretized chord vertices of an `arc` as 3D prism edges!
* - For `arc` segments in a prism, only emits standard quadrant silhouette generators (0, PI/2, PI, 3*PI/2)
*   and non-tangent endpoint hard edges (where tangent angle difference > 5 degrees).
* - Computes exact 3D space intersection curves (`curves3D`) where holes/cylinders intersect curved arc surfaces.
*/
export function generateAllCandidate3DEdges(targetView, baseExtrusions, bossSolids, subSolids) {
	const lines3D = [];
	const circles3D = [];
	const curves3D = [];
	const pushBoxEdges = (prim, ownerType, ownerId) => {
		const { xMin, xMax, yMin, yMax, zMin, zMax, featureId, label } = prim;
		const xPlanes = [xMin, xMax];
		const yPlanes = [yMin, yMax];
		const zPlanes = [zMin, zMax];
		if (ownerType === "subtract") {
			for (const b of baseExtrusions) {
				for (const bx of [b.xMin, b.xMax]) if (bx > xMin + .1 && bx < xMax - .1 && !xPlanes.some((v) => Math.abs(v - bx) < .05)) xPlanes.push(bx);
				for (const by of [b.yMin, b.yMax]) if (by > yMin + .1 && by < yMax - .1 && !yPlanes.some((v) => Math.abs(v - by) < .05)) yPlanes.push(by);
				for (const bz of [b.zMin, b.zMax]) if (bz > zMin + .1 && bz < zMax - .1 && !zPlanes.some((v) => Math.abs(v - bz) < .05)) zPlanes.push(bz);
			}
		}
		for (const y of yPlanes) for (const z of zPlanes) lines3D.push({
			p1: { x: xMin, y, z },
			p2: { x: xMax, y, z },
			ownerType,
			ownerId,
			featureId,
			featureLabel: label
		});
		for (const x of xPlanes) for (const z of zPlanes) lines3D.push({
			p1: { x, y: yMin, z },
			p2: { x, y: yMax, z },
			ownerType,
			ownerId,
			featureId,
			featureLabel: label
		});
		for (const x of xPlanes) for (const y of yPlanes) lines3D.push({
			p1: { x, y, z: zMin },
			p2: { x, y, z: zMax },
			ownerType,
			ownerId,
			featureId,
			featureLabel: label
		});
	};
	const pushPrismEdges = (prim, ownerType, ownerId) => {
		const poly = prim.prismPolygon;
		if (!poly || poly.length < 3) {
			pushBoxEdges(prim, ownerType, ownerId);
			return;
		}
		const axis = prim.prismAxis || "Y";
		const { xMin, xMax, yMin, yMax, zMin, zMax, featureId, label } = prim;
		const wPlanes = axis === "Y" ? [yMin, yMax] : axis === "Z" ? [zMin, zMax] : [xMin, xMax];
		if (ownerType === "subtract") {
			for (const b of baseExtrusions) {
				const bwBounds = axis === "Y" ? [b.yMin, b.yMax] : axis === "Z" ? [b.zMin, b.zMax] : [b.xMin, b.xMax];
				const wLo = wPlanes[0];
				const wHi = wPlanes[1];
				for (const bw of bwBounds) if (bw > wLo + .1 && bw < wHi - .1 && !wPlanes.some((v) => Math.abs(v - bw) < .05)) wPlanes.push(bw);
			}
		}
		const pushExtrusionLineAtUV = (u, v) => {
			if (axis === "Y") lines3D.push({
				p1: {
					x: u,
					y: yMin,
					z: v
				},
				p2: {
					x: u,
					y: yMax,
					z: v
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (axis === "Z") lines3D.push({
				p1: {
					x: u,
					y: v,
					z: zMin
				},
				p2: {
					x: u,
					y: v,
					z: zMax
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else lines3D.push({
				p1: {
					x: xMin,
					y: u,
					z: v
				},
				p2: {
					x: xMax,
					y: u,
					z: v
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
		};
		const pushCapSegmentUV = (a, b) => {
			for (const wVal of wPlanes) {
				if (axis === "Y") lines3D.push({
					p1: {
						x: a.u,
						y: wVal,
						z: a.v
					},
					p2: {
						x: b.u,
						y: wVal,
						z: b.v
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				else if (axis === "Z") lines3D.push({
					p1: {
						x: a.u,
						y: a.v,
						z: wVal
					},
					p2: {
						x: b.u,
						y: b.v,
						z: wVal
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				else lines3D.push({
					p1: {
						x: wVal,
						y: a.u,
						z: a.v
					},
					p2: {
						x: wVal,
						y: b.u,
						z: b.v
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
			}
		};
		const segs = prim.prismSegments;
		if (segs && segs.length >= 2) {
			const m = segs.length;
			const COS_5_DEG = Math.cos(5 * Math.PI / 180);
			const getSegmentTangents = (s) => {
				if (s.kind === "arc" && s.startAngle !== void 0 && s.endAngle !== void 0) {
					if (s.ccw !== false) return {
						tOut: {
							u: -Math.sin(s.startAngle),
							v: Math.cos(s.startAngle)
						},
						tIn: {
							u: -Math.sin(s.endAngle),
							v: Math.cos(s.endAngle)
						}
					};
					return {
						tOut: {
							u: Math.sin(s.endAngle),
							v: -Math.cos(s.endAngle)
						},
						tIn: {
							u: Math.sin(s.startAngle),
							v: -Math.cos(s.startAngle)
						}
					};
				}
				const len = Math.hypot(s.p2.u - s.p1.u, s.p2.v - s.p1.v) || 1;
				const t = {
					u: (s.p2.u - s.p1.u) / len,
					v: (s.p2.v - s.p1.v) / len
				};
				return {
					tOut: t,
					tIn: t
				};
			};
			for (let i = 0; i < m; i++) {
				const prevSeg = segs[(i - 1 + m) % m];
				const curSeg = segs[i];
				const { tIn } = getSegmentTangents(prevSeg);
				const { tOut } = getSegmentTangents(curSeg);
				if (tIn.u * tOut.u + tIn.v * tOut.v < COS_5_DEG) pushExtrusionLineAtUV(curSeg.p1.u, curSeg.p1.v);
				if (curSeg.kind === "arc" && curSeg.center && curSeg.radius !== void 0 && curSeg.startAngle !== void 0 && curSeg.endAngle !== void 0) {
					const quadrantAngles = axis === "Y" ? targetView === "top" ? [0, Math.PI] : targetView === "left" ? [Math.PI * .5, Math.PI * 1.5] : [] : axis === "Z" ? targetView === "front" ? [0, Math.PI] : targetView === "left" ? [Math.PI * .5, Math.PI * 1.5] : [] : targetView === "top" ? [0, Math.PI] : targetView === "front" ? [Math.PI * .5, Math.PI * 1.5] : [];
					for (const qAng of quadrantAngles) if (isAngleOnArc(qAng, curSeg.startAngle, curSeg.endAngle, -.02)) pushExtrusionLineAtUV(curSeg.center.u + curSeg.radius * Math.cos(qAng), curSeg.center.v + curSeg.radius * Math.sin(qAng));
					if (axis === "Y" && targetView === "front" || axis === "Z" && targetView === "top" || axis === "X" && targetView === "left") {
						if (axis === "Y") circles3D.push({
							center: {
								x: curSeg.center.u,
								y: yMin,
								z: curSeg.center.v
							},
							radius: curSeg.radius,
							axis: "Y",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						}, {
							center: {
								x: curSeg.center.u,
								y: yMax,
								z: curSeg.center.v
							},
							radius: curSeg.radius,
							axis: "Y",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
						else if (axis === "Z") circles3D.push({
							center: {
								x: curSeg.center.u,
								y: curSeg.center.v,
								z: zMin
							},
							radius: curSeg.radius,
							axis: "Z",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						}, {
							center: {
								x: curSeg.center.u,
								y: curSeg.center.v,
								z: zMax
							},
							radius: curSeg.radius,
							axis: "Z",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
						else circles3D.push({
							center: {
								x: xMin,
								y: curSeg.center.u,
								z: curSeg.center.v
							},
							radius: curSeg.radius,
							axis: "X",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						}, {
							center: {
								x: xMax,
								y: curSeg.center.u,
								z: curSeg.center.v
							},
							radius: curSeg.radius,
							axis: "X",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
					} else {
						const span = normalizeAngle(curSeg.endAngle - curSeg.startAngle);
						const N_CAP = 32;
						for (let k = 0; k < N_CAP; k++) {
							const a1 = curSeg.startAngle + k / N_CAP * span;
							const a2 = curSeg.startAngle + (k + 1) / N_CAP * span;
							pushCapSegmentUV({
								u: curSeg.center.u + curSeg.radius * Math.cos(a1),
								v: curSeg.center.v + curSeg.radius * Math.sin(a1)
							}, {
								u: curSeg.center.u + curSeg.radius * Math.cos(a2),
								v: curSeg.center.v + curSeg.radius * Math.sin(a2)
							});
						}
					}
				} else pushCapSegmentUV(curSeg.p1, curSeg.p2);
			}
		}
		const emitBoundaryCrossings = (linePairs: Array<{ a: Point2D; b: Point2D }>) => {
			if (ownerType !== "subtract") return;
			for (const base of baseExtrusions) {
				const uBounds = axis === "Y" || axis === "Z" ? [base.xMin, base.xMax] : [base.yMin, base.yMax];
				const vBounds = axis === "Y" || axis === "X" ? [base.zMin, base.zMax] : [base.yMin, base.yMax];
				for (const uB of uBounds) {
					const vHits: number[] = [];
					for (const { a, b } of linePairs) {
						if ((a.u - uB) * (b.u - uB) <= 0 && Math.abs(b.u - a.u) > .1) {
							const t = (uB - a.u) / (b.u - a.u);
							if (t >= -.01 && t <= 1.01) {
								const vInt = a.v + t * (b.v - a.v);
								pushExtrusionLineAtUV(uB, vInt);
								vHits.push(vInt);
							}
						}
					}
					if (vHits.length >= 2) {
						vHits.sort((x, y) => x - y);
						pushCapSegmentUV({ u: uB, v: vHits[0] }, { u: uB, v: vHits[vHits.length - 1] });
					}
				}
				for (const vB of vBounds) {
					const uHits: number[] = [];
					for (const { a, b } of linePairs) {
						if ((a.v - vB) * (b.v - vB) <= 0 && Math.abs(b.v - a.v) > .1) {
							const t = (vB - a.v) / (b.v - a.v);
							if (t >= -.01 && t <= 1.01) {
								const uInt = a.u + t * (b.u - a.u);
								pushExtrusionLineAtUV(uInt, vB);
								uHits.push(uInt);
							}
						}
					}
					if (uHits.length >= 2) {
						uHits.sort((x, y) => x - y);
						pushCapSegmentUV({ u: uHits[0], v: vB }, { u: uHits[uHits.length - 1], v: vB });
					}
				}
			}
		};
		if (segs && segs.length >= 2) {
			emitBoundaryCrossings(segs.filter((s) => s.kind !== "arc").map((s) => ({ a: s.p1, b: s.p2 })));
			return;
		}
		const n = poly.length;
		const polyPairs: Array<{ a: Point2D; b: Point2D }> = [];
		for (let i = 0; i < n; i++) {
			const a = poly[i];
			const b = poly[(i + 1) % n];
			pushExtrusionLineAtUV(a.u, a.v);
			pushCapSegmentUV(a, b);
			polyPairs.push({ a, b });
		}
		emitBoundaryCrossings(polyPairs);
	};
	const pushCylinderEdges = (prim, ownerType, ownerId) => {
		const r = prim.radius ?? .5 * (prim.xMax - prim.xMin);
		const { xMin, xMax, yMin, yMax, zMin, zMax, featureId, label } = prim;
		if (prim.shape === "cylinder_z") {
			const cx = prim.centerX ?? .5 * (xMin + xMax);
			const cy = prim.centerY ?? .5 * (yMin + yMax);
			const zCaps = [zMin, zMax];
			let effZMin = zMin;
			let effZMax = zMax;
			if (ownerType === "subtract" && baseExtrusions.length > 0) {
				const bZMin = Math.min(...baseExtrusions.map((b) => b.zMin));
				const bZMax = Math.max(...baseExtrusions.map((b) => b.zMax));
				if (zMin < bZMin && zMax > bZMin) {
					effZMin = bZMin;
					if (!zCaps.some((v) => Math.abs(v - bZMin) < .05)) zCaps.push(bZMin);
				}
				if (zMax > bZMax && zMin < bZMax) {
					effZMax = bZMax;
					if (!zCaps.some((v) => Math.abs(v - bZMax) < .05)) zCaps.push(bZMax);
				}
			}
			if (targetView === "front") lines3D.push({
				p1: {
					x: cx - r,
					y: cy,
					z: effZMin
				},
				p2: {
					x: cx - r,
					y: cy,
					z: effZMax
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: cx + r,
					y: cy,
					z: effZMin
				},
				p2: {
					x: cx + r,
					y: cy,
					z: effZMax
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "left") lines3D.push({
				p1: {
					x: cx,
					y: cy - r,
					z: effZMin
				},
				p2: {
					x: cx,
					y: cy - r,
					z: effZMax
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: cx,
					y: cy + r,
					z: effZMin
				},
				p2: {
					x: cx,
					y: cy + r,
					z: effZMax
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			if (targetView === "top") {
				for (const zCap of zCaps) circles3D.push({
					center: {
						x: cx,
						y: cy,
						z: zCap
					},
					radius: r,
					axis: "Z",
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
			} else if (targetView === "front") for (const zCap of zCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: cx - r,
					y: cy,
					z: zCap
				},
				p2: {
					x: cx + r,
					y: cy,
					z: zCap
				},
				evalPt3D: (t) => {
					const x = cx - r + 2 * r * t;
					const dy = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
					return {
						x,
						y: cy + sideSign * dy,
						z: zCap
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "left") for (const zCap of zCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: cx,
					y: cy - r,
					z: zCap
				},
				p2: {
					x: cx,
					y: cy + r,
					z: zCap
				},
				evalPt3D: (t) => {
					const y = cy - r + 2 * r * t;
					const dx = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy)));
					return {
						x: cx + sideSign * dx,
						y,
						z: zCap
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
		} else if (prim.shape === "cylinder_y") {
			const cx = prim.centerX ?? .5 * (xMin + xMax);
			const cz = prim.centerZ ?? .5 * (zMin + zMax);
			const yCaps = [yMin, yMax];
			let effYMin = yMin;
			let effYMax = yMax;
			if (ownerType === "subtract" && baseExtrusions.length > 0) {
				const bYMin = Math.min(...baseExtrusions.map((b) => b.yMin));
				const bYMax = Math.max(...baseExtrusions.map((b) => b.yMax));
				if (yMin < bYMin && yMax > bYMin) {
					effYMin = bYMin;
					if (!yCaps.some((v) => Math.abs(v - bYMin) < .05)) yCaps.push(bYMin);
				}
				if (yMax > bYMax && yMin < bYMax) {
					effYMax = bYMax;
					if (!yCaps.some((v) => Math.abs(v - bYMax) < .05)) yCaps.push(bYMax);
				}
			}
			if (targetView === "top") lines3D.push({
				p1: {
					x: cx - r,
					y: effYMin,
					z: cz
				},
				p2: {
					x: cx - r,
					y: effYMax,
					z: cz
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: cx + r,
					y: effYMin,
					z: cz
				},
				p2: {
					x: cx + r,
					y: effYMax,
					z: cz
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "left") lines3D.push({
				p1: {
					x: cx,
					y: effYMin,
					z: cz - r
				},
				p2: {
					x: cx,
					y: effYMax,
					z: cz - r
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: cx,
					y: effYMin,
					z: cz + r
				},
				p2: {
					x: cx,
					y: effYMax,
					z: cz + r
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			if (targetView === "front") {
				for (const yCap of yCaps) circles3D.push({
					center: {
						x: cx,
						y: yCap,
						z: cz
					},
					radius: r,
					axis: "Y",
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
			} else if (targetView === "top") for (const yCap of yCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: cx - r,
					y: yCap,
					z: cz
				},
				p2: {
					x: cx + r,
					y: yCap,
					z: cz
				},
				evalPt3D: (t) => {
					const x = cx - r + 2 * r * t;
					const dz = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
					return {
						x,
						y: yCap,
						z: cz + sideSign * dz
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "left") for (const yCap of yCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: cx,
					y: yCap,
					z: cz - r
				},
				p2: {
					x: cx,
					y: yCap,
					z: cz + r
				},
				evalPt3D: (t) => {
					const z = cz - r + 2 * r * t;
					const dx = Math.sqrt(Math.max(0, r * r - (z - cz) * (z - cz)));
					return {
						x: cx + sideSign * dx,
						y: yCap,
						z
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
		} else if (prim.shape === "cylinder_x") {
			const cy = prim.centerY ?? .5 * (yMin + yMax);
			const cz = prim.centerZ ?? .5 * (zMin + zMax);
			const xCaps = [xMin, xMax];
			let effXMin = xMin;
			let effXMax = xMax;
			if (ownerType === "subtract" && baseExtrusions.length > 0) {
				const bXMin = Math.min(...baseExtrusions.map((b) => b.xMin));
				const bXMax = Math.max(...baseExtrusions.map((b) => b.xMax));
				if (xMin < bXMin && xMax > bXMin) {
					effXMin = bXMin;
					if (!xCaps.some((v) => Math.abs(v - bXMin) < .05)) xCaps.push(bXMin);
				}
				if (xMax > bXMax && xMin < bXMax) {
					effXMax = bXMax;
					if (!xCaps.some((v) => Math.abs(v - bXMax) < .05)) xCaps.push(bXMax);
				}
			}
			if (targetView === "top") lines3D.push({
				p1: {
					x: effXMin,
					y: cy - r,
					z: cz
				},
				p2: {
					x: effXMax,
					y: cy - r,
					z: cz
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: effXMin,
					y: cy + r,
					z: cz
				},
				p2: {
					x: effXMax,
					y: cy + r,
					z: cz
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "front") lines3D.push({
				p1: {
					x: effXMin,
					y: cy,
					z: cz - r
				},
				p2: {
					x: effXMax,
					y: cy,
					z: cz - r
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			}, {
				p1: {
					x: effXMin,
					y: cy,
					z: cz + r
				},
				p2: {
					x: effXMax,
					y: cy,
					z: cz + r
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			if (targetView === "left") {
				for (const xCap of xCaps) circles3D.push({
					center: {
						x: xCap,
						y: cy,
						z: cz
					},
					radius: r,
					axis: "X",
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
			} else if (targetView === "front") for (const xCap of xCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: xCap,
					y: cy,
					z: cz - r
				},
				p2: {
					x: xCap,
					y: cy,
					z: cz + r
				},
				evalPt3D: (t) => {
					const z = cz - r + 2 * r * t;
					const dy = Math.sqrt(Math.max(0, r * r - (z - cz) * (z - cz)));
					return {
						x: xCap,
						y: cy + sideSign * dy,
						z
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			else if (targetView === "top") for (const xCap of xCaps) for (const sideSign of [-1, 1]) lines3D.push({
				p1: {
					x: xCap,
					y: cy - r,
					z: cz
				},
				p2: {
					x: xCap,
					y: cy + r,
					z: cz
				},
				evalPt3D: (t) => {
					const y = cy - r + 2 * r * t;
					const dz = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy)));
					return {
						x: xCap,
						y,
						z: cz + sideSign * dz
					};
				},
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
		}
	};
	const pushParametricSolidEdges = (prim, ownerType, ownerId) => {
		const { xMin, xMax, yMin, yMax, zMin, zMax, featureId, label } = prim;
		const xc = prim.centerX ?? .5 * (xMin + xMax);
		const yc = prim.centerY ?? .5 * (yMin + yMax);
		const zc = prim.centerZ ?? .5 * (zMin + zMax);
		if (prim.shape === "sphere" || prim.shape === "hemisphere") {
			const r = prim.radius ?? .5 * Math.max(xMax - xMin, yMax - yMin, zMax - zMin);
			const axis = targetView === "front" ? "Y" : targetView === "top" ? "Z" : "X";
			circles3D.push({
				center: {
					x: xc,
					y: yc,
					z: zc
				},
				radius: r,
				axis,
				ownerType,
				ownerId,
				featureId,
				featureLabel: label
			});
			if (prim.shape === "hemisphere") {
				pushBoxEdges(prim, ownerType, ownerId);
				const isFlatZ = (Math.abs(zc - zMin) <= 3.5 && zMax > zc + 3.5) || (Math.abs(zc - zMax) <= 3.5 && zMin < zc - 3.5);
				const isFlatY = (Math.abs(yc - yMin) <= 3.5 && yMax > yc + 3.5) || (Math.abs(yc - yMax) <= 3.5 && yMin < yc - 3.5);
				const isFlatX = (Math.abs(xc - xMin) <= 3.5 && xMax > xc + 3.5) || (Math.abs(xc - xMax) <= 3.5 && xMin < xc - 3.5);
				const zFlat = Math.abs(zc - zMin) <= 3.5 && zMax > zc ? zc : Math.abs(zc - zMax) <= 3.5 && zMin < zc ? zc : zMin;
				const yFlat = Math.abs(yc - yMin) <= 3.5 && yMax > yc ? yc : Math.abs(yc - yMax) <= 3.5 && yMin < yc ? yc : yc;
				const xFlat = Math.abs(xc - xMin) <= 3.5 && xMax > xc ? xc : Math.abs(xc - xMax) <= 3.5 && xMin < xc ? xc : xc;
				if (isFlatZ) {
					if (targetView === "top") {
						circles3D.push({
							center: { x: xc, y: yc, z: zFlat },
							radius: r,
							axis: "Z",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
					} else {
						for (const sideSign of [-1, 1]) {
							lines3D.push({
								p1: targetView === "front" ? { x: xc - r, y: yc, z: zFlat } : { x: xc, y: yc - r, z: zFlat },
								p2: targetView === "front" ? { x: xc + r, y: yc, z: zFlat } : { x: xc, y: yc + r, z: zFlat },
								evalPt3D: (t) => {
									const u = -r + 2 * r * t;
									const v = Math.sqrt(Math.max(0, r * r - u * u));
									return targetView === "front" ? { x: xc + u, y: yc + sideSign * v, z: zFlat } : { x: xc + sideSign * v, y: yc + u, z: zFlat };
								},
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							});
						}
					}
				}
				if (isFlatY) {
					if (targetView === "front") {
						circles3D.push({
							center: { x: xc, y: yFlat, z: zc },
							radius: r,
							axis: "Y",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
					} else {
						for (const sideSign of [-1, 1]) {
							lines3D.push({
								p1: targetView === "top" ? { x: xc - r, y: yFlat, z: zc } : { x: xc, y: yFlat, z: zc - r },
								p2: targetView === "top" ? { x: xc + r, y: yFlat, z: zc } : { x: xc, y: yFlat, z: zc + r },
								evalPt3D: (t) => {
									const u = -r + 2 * r * t;
									const v = Math.sqrt(Math.max(0, r * r - u * u));
									return targetView === "top" ? { x: xc + u, y: yFlat, z: zc + sideSign * v } : { x: xc + sideSign * v, y: yFlat, z: zc + u };
								},
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							});
						}
					}
				}
				if (isFlatX) {
					if (targetView === "left") {
						circles3D.push({
							center: { x: xFlat, y: yc, z: zc },
							radius: r,
							axis: "X",
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
					} else {
						for (const sideSign of [-1, 1]) {
							lines3D.push({
								p1: targetView === "front" ? { x: xFlat, y: yc, z: zc - r } : { x: xFlat, y: yc - r, z: zc },
								p2: targetView === "front" ? { x: xFlat, y: yc, z: zc + r } : { x: xFlat, y: yc + r, z: zc },
								evalPt3D: (t) => {
									const u = -r + 2 * r * t;
									const v = Math.sqrt(Math.max(0, r * r - u * u));
									return targetView === "front" ? { x: xFlat, y: yc + sideSign * v, z: zc + u } : { x: xFlat, y: yc + u, z: zc + sideSign * v };
								},
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							});
						}
					}
				}
				lines3D.push(
					{
						p1: { x: xc, y: yc - r, z: zFlat },
						p2: { x: xc, y: yc + r, z: zFlat },
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					},
					{
						p1: { x: xc - r, y: yc, z: zFlat },
						p2: { x: xc + r, y: yc, z: zFlat },
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					},
					{
						p1: { x: xc, y: yFlat, z: zc - r },
						p2: { x: xc, y: yFlat, z: zc + r },
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					}
				);
			}
			return;
		}
		if (prim.shape === "cone_z" || prim.shape === "cone_y" || prim.shape === "cone_x") {
			const r0 = prim.rMin ?? prim.radius ?? .5 * Math.min(xMax - xMin, yMax - yMin);
			const r1 = prim.rMax ?? 0;
			if (prim.shape === "cone_z") {
				const xc0 = (prim as any).uCenterMin ?? xc;
				const xc1 = (prim as any).uCenterMax ?? xc;
				const yc0 = (prim as any).vCenterMin ?? yc;
				const yc1 = (prim as any).vCenterMax ?? yc;
				for (const sign of [-1, 1]) if (targetView === "front") lines3D.push({
					p1: {
						x: xc0 + sign * r0,
						y: yc0,
						z: zMin
					},
					p2: {
						x: xc1 + sign * r1,
						y: yc1,
						z: zMax
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				else if (targetView === "left") lines3D.push({
					p1: {
						x: xc0,
						y: yc0 + sign * r0,
						z: zMin
					},
					p2: {
						x: xc1,
						y: yc1 + sign * r1,
						z: zMax
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				if (targetView === "top") {
					if (r0 > .5) circles3D.push({
						center: {
							x: xc0,
							y: yc0,
							z: zMin
						},
						radius: r0,
						axis: "Z",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
					if (r1 > .5) circles3D.push({
						center: {
							x: xc1,
							y: yc1,
							z: zMax
						},
						radius: r1,
						axis: "Z",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				} else for (const [zCap, rCap, xCapC, yCapC] of [[zMin, r0, xc0, yc0], [zMax, r1, xc1, yc1]]) {
					if (rCap <= .5) continue;
					for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "front" ? {
							x: xCapC - rCap,
							y: yCapC,
							z: zCap
						} : {
							x: xCapC,
							y: yCapC - rCap,
							z: zCap
						},
						p2: targetView === "front" ? {
							x: xCapC + rCap,
							y: yCapC,
							z: zCap
						} : {
							x: xCapC,
							y: yCapC + rCap,
							z: zCap
						},
						evalPt3D: (t) => {
							const u = -rCap + 2 * rCap * t;
							const v = Math.sqrt(Math.max(0, rCap * rCap - u * u));
							return targetView === "front" ? {
								x: xCapC + u,
								y: yCapC + sideSign * v,
								z: zCap
							} : {
								x: xCapC + sideSign * v,
								y: yCapC + u,
								z: zCap
							};
						},
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				}
			} else if (prim.shape === "cone_y") {
				const xc0 = (prim as any).uCenterMin ?? xc;
				const xc1 = (prim as any).uCenterMax ?? xc;
				const zc0 = (prim as any).vCenterMin ?? zc;
				const zc1 = (prim as any).vCenterMax ?? zc;
				for (const sign of [-1, 1]) if (targetView === "top") lines3D.push({
					p1: {
						x: xc0 + sign * r0,
						y: yMin,
						z: zc0
					},
					p2: {
						x: xc1 + sign * r1,
						y: yMax,
						z: zc1
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				else if (targetView === "left") lines3D.push({
					p1: {
						x: xc0,
						y: yMin,
						z: zc0 + sign * r0
					},
					p2: {
						x: xc1,
						y: yMax,
						z: zc1 + sign * r1
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				if (targetView === "front") {
					if (r0 > .5) circles3D.push({
						center: {
							x: xc0,
							y: yMin,
							z: zc0
						},
						radius: r0,
						axis: "Y",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
					if (r1 > .5) circles3D.push({
						center: {
							x: xc1,
							y: yMax,
							z: zc1
						},
						radius: r1,
						axis: "Y",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				} else for (const [yCap, rCap, xCapC, zCapC] of [[yMin, r0, xc0, zc0], [yMax, r1, xc1, zc1]]) {
					if (rCap <= .5) continue;
					for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "top" ? {
							x: xCapC - rCap,
							y: yCap,
							z: zCapC
						} : {
							x: xCapC,
							y: yCap,
							z: zCapC - rCap
						},
						p2: targetView === "top" ? {
							x: xCapC + rCap,
							y: yCap,
							z: zCapC
						} : {
							x: xCapC,
							y: yCap,
							z: zCapC + rCap
						},
						evalPt3D: (t) => {
							const u = -rCap + 2 * rCap * t;
							const v = Math.sqrt(Math.max(0, rCap * rCap - u * u));
							return targetView === "top" ? {
								x: xCapC + u,
								y: yCap,
								z: zCapC + sideSign * v
							} : {
								x: xCapC + sideSign * v,
								y: yCap,
								z: zCapC + u
							};
						},
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				}
			} else {
				const yc0 = (prim as any).uCenterMin ?? yc;
				const yc1 = (prim as any).uCenterMax ?? yc;
				const zc0 = (prim as any).vCenterMin ?? zc;
				const zc1 = (prim as any).vCenterMax ?? zc;
				for (const sign of [-1, 1]) if (targetView === "top") lines3D.push({
					p1: {
						x: xMin,
						y: yc0 + sign * r0,
						z: zc0
					},
					p2: {
						x: xMax,
						y: yc1 + sign * r1,
						z: zc1
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				else if (targetView === "front") lines3D.push({
					p1: {
						x: xMin,
						y: yc0,
						z: zc0 + sign * r0
					},
					p2: {
						x: xMax,
						y: yc1,
						z: zc1 + sign * r1
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				if (targetView === "left") {
					if (r0 > .5) circles3D.push({
						center: {
							x: xMin,
							y: yc0,
							z: zc0
						},
						radius: r0,
						axis: "X",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
					if (r1 > .5) circles3D.push({
						center: {
							x: xMax,
							y: yc1,
							z: zc1
						},
						radius: r1,
						axis: "X",
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				} else for (const [xCap, rCap, yCapC, zCapC] of [[xMin, r0, yc0, zc0], [xMax, r1, yc1, zc1]]) {
					if (rCap <= .5) continue;
					for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "front" ? {
							x: xCap,
							y: yCapC,
							z: zCapC - rCap
						} : {
							x: xCap,
							y: yCapC - rCap,
							z: zCapC
						},
						p2: targetView === "front" ? {
							x: xCap,
							y: yCapC,
							z: zCapC + rCap
						} : {
							x: xCap,
							y: yCapC + rCap,
							z: zCapC
						},
						evalPt3D: (t) => {
							const u = -rCap + 2 * rCap * t;
							const v = Math.sqrt(Math.max(0, rCap * rCap - u * u));
							return targetView === "front" ? {
								x: xCap,
								y: yCapC + sideSign * v,
								z: zCapC + u
							} : {
								x: xCap,
								y: yCapC + u,
								z: zCapC + sideSign * v
							};
						},
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				}
			}
			return;
		}
		if (prim.shape === "pyramid" && prim.prismPolygon && prim.prismPolygon.length >= 3 && prim.apex3D) {
			const pts = prim.prismPolygon;
			const segs = prim.prismSegments;
			const axis = prim.prismAxis || "Z";
			const [ax, ay, az] = prim.apex3D;
			const apexPt = {
				x: ax,
				y: ay,
				z: az
			};
			const topScale = typeof prim.pyramidTopScale === "number" && prim.pyramidTopScale > 1e-3 ? prim.pyramidTopScale : 0;
			const baseW = axis === "Z" ? Math.abs(az - zMin) > Math.abs(az - zMax) ? zMin : zMax : axis === "Y" ? Math.abs(ay - yMin) > Math.abs(ay - yMax) ? yMin : yMax : Math.abs(ax - xMin) > Math.abs(ax - xMax) ? xMin : xMax;
			const topW = axis === "Z" ? (baseW === zMin ? zMax : zMin) : axis === "Y" ? (baseW === yMin ? yMax : yMin) : (baseW === xMin ? xMax : xMin);
			const uApex = axis === "Z" ? ax : axis === "Y" ? ax : ay;
			const vApex = axis === "Z" ? ay : axis === "Y" ? az : az;
			const toBase3D = (u: number, v: number) => axis === "Z" ? { x: u, y: v, z: baseW } : axis === "Y" ? { x: u, y: baseW, z: v } : { x: baseW, y: u, z: v };
			const toTop3D = (u: number, v: number) => {
				if (topScale <= 1e-3) return apexPt;
				const tFactor = 1 - topScale;
				const uTop = u + tFactor * (uApex - u);
				const vTop = v + tFactor * (vApex - v);
				return axis === "Z" ? { x: uTop, y: vTop, z: topW } : axis === "Y" ? { x: uTop, y: topW, z: vTop } : { x: topW, y: uTop, z: vTop };
			};
			const hasArcSeg = Array.isArray(segs) && segs.some((s: any) => s.kind === "arc");
			if (hasArcSeg && segs) {
				const isBaseParallelView = (axis === "Y" && targetView === "front") || (axis === "Z" && targetView === "top") || (axis === "X" && targetView === "left");
				const generatorUVs: { u: number; v: number }[] = [];
				const addGenUV = (pt: { u: number; v: number }) => {
					if (!generatorUVs.some((g) => Math.hypot(g.u - pt.u, g.v - pt.v) <= 0.4)) {
						generatorUVs.push({ u: pt.u, v: pt.v });
					}
				};
				for (const s of segs) {
					if (s.p1) addGenUV(s.p1);
					if (s.p2) addGenUV(s.p2);
					if (s.kind === "arc" && s.center && s.radius !== void 0 && s.startAngle !== void 0 && s.endAngle !== void 0) {
						if (isBaseParallelView) {
							circles3D.push({
								center: toBase3D(s.center.u, s.center.v),
								radius: s.radius,
								axis: axis as "X" | "Y" | "Z",
								isArc: true,
								startAngle: s.startAngle,
								endAngle: s.endAngle,
								ccw: s.ccw !== false,
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							});
							if (topScale > 1e-3) {
								circles3D.push({
									center: toTop3D(s.center.u, s.center.v),
									radius: s.radius * topScale,
									axis: axis as "X" | "Y" | "Z",
									isArc: true,
									startAngle: s.startAngle,
									endAngle: s.endAngle,
									ccw: s.ccw !== false,
									ownerType,
									ownerId,
									featureId,
									featureLabel: label
								});
							}
						}
						for (const qAng of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
							if (isAngleOnArc(qAng, s.startAngle, s.endAngle, 1e-3)) {
								addGenUV({
									u: s.center.u + s.radius * Math.cos(qAng),
									v: s.center.v + s.radius * Math.sin(qAng)
								});
							}
						}
					} else if (s.p1 && s.p2) {
						addGenUV({
							u: 0.5 * (s.p1.u + s.p2.u),
							v: 0.5 * (s.p1.v + s.p2.v)
						});
						lines3D.push({
							p1: toBase3D(s.p1.u, s.p1.v),
							p2: toBase3D(s.p2.u, s.p2.v),
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						});
						if (topScale > 1e-3) {
							lines3D.push({
								p1: toTop3D(s.p1.u, s.p1.v),
								p2: toTop3D(s.p2.u, s.p2.v),
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							});
						}
					}
				}
				if (!isBaseParallelView && generatorUVs.length >= 2) {
					const uMinBase = Math.min(...pts.map((p) => p.u));
					const uMaxBase = Math.max(...pts.map((p) => p.u));
					const vMinBase = Math.min(...pts.map((p) => p.v));
					const vMaxBase = Math.max(...pts.map((p) => p.v));
					lines3D.push(
						{
							p1: toBase3D(uMinBase, vMinBase),
							p2: toBase3D(uMaxBase, vMinBase),
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						},
						{
							p1: toBase3D(uMinBase, vMaxBase),
							p2: toBase3D(uMaxBase, vMaxBase),
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						},
						{
							p1: toBase3D(.5 * (uMinBase + uMaxBase), vMinBase),
							p2: toBase3D(.5 * (uMinBase + uMaxBase), vMaxBase),
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						},
						{
							p1: toBase3D(uMinBase, .5 * (vMinBase + vMaxBase)),
							p2: toBase3D(uMaxBase, .5 * (vMinBase + vMaxBase)),
							ownerType,
							ownerId,
							featureId,
							featureLabel: label
						}
					);
					if (topScale > 1e-3) {
						lines3D.push(
							{
								p1: toTop3D(.5 * (uMinBase + uMaxBase), vMinBase),
								p2: toTop3D(.5 * (uMinBase + uMaxBase), vMaxBase),
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							},
							{
								p1: toTop3D(uMinBase, .5 * (vMinBase + vMaxBase)),
								p2: toTop3D(uMaxBase, .5 * (vMinBase + vMaxBase)),
								ownerType,
								ownerId,
								featureId,
								featureLabel: label
							}
						);
					}
				}
				for (const g of generatorUVs) {
					lines3D.push({
						p1: toBase3D(g.u, g.v),
						p2: toTop3D(g.u, g.v),
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				}
				return;
			}
			const basePts3D = pts.map((p) => toBase3D(p.u, p.v));
			for (let i = 0; i < basePts3D.length; i++) {
				const b1 = basePts3D[i];
				const b2 = basePts3D[(i + 1) % basePts3D.length];
				const t1 = toTop3D(pts[i].u, pts[i].v);
				lines3D.push({
					p1: b1,
					p2: b2,
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				}, {
					p1: b1,
					p2: t1,
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
				if (topScale > 1e-3) {
					const nextPt = pts[(i + 1) % basePts3D.length];
					lines3D.push({
						p1: t1,
						p2: toTop3D(nextPt.u, nextPt.v),
						ownerType,
						ownerId,
						featureId,
						featureLabel: label
					});
				}
			}
			return;
		}
		if (prim.shape === "plane_sheet" && prim.vertices3D && prim.vertices3D.length >= 3) {
			const v3 = prim.vertices3D;
			for (let i = 0; i < v3.length; i++) {
				const a = v3[i];
				const b = v3[(i + 1) % v3.length];
				lines3D.push({
					p1: {
						x: a[0],
						y: a[1],
						z: a[2]
					},
					p2: {
						x: b[0],
						y: b[1],
						z: b[2]
					},
					ownerType,
					ownerId,
					featureId,
					featureLabel: label
				});
			}
			return;
		}
	};
	const dispatchSolidEdges = (prim, ownerType, ownerId) => {
		if (prim.id.startsWith("sub-frustum-notch-")) return;
		if (prim.shape === "generalized_loft") {
			const loft = primitiveToGeneralizedLoft(prim);
			if (loft) {
				const loftOut = extractGeneralizedLoftEdgesAndSilhouettes(loft, targetView);
				for (const ls of loftOut.lines3D) {
					lines3D.push({
						p1: ls.p1,
						p2: ls.p2,
						ownerType,
						ownerId,
						featureId: prim.featureId,
						featureLabel: prim.label
					});
				}
				for (const lc of loftOut.circles3D) {
					circles3D.push({
						...lc,
						ownerType,
						ownerId,
						featureId: prim.featureId,
						featureLabel: prim.label
					});
				}
			}
			return;
		}
		if (prim.shape.startsWith("cylinder_")) pushCylinderEdges(prim, ownerType, ownerId);
		else if (prim.shape === "sphere" || prim.shape === "hemisphere" || prim.shape.startsWith("cone_") || prim.shape === "pyramid" || prim.shape === "plane_sheet") pushParametricSolidEdges(prim, ownerType, ownerId);
		else if (prim.shape === "prism") pushPrismEdges(prim, ownerType, ownerId);
		else pushBoxEdges(prim, ownerType, ownerId);
	};
	const hasMultiAddBases = baseExtrusions.filter((b) => b.operation === "add").length > 1;
	for (const b of baseExtrusions) dispatchSolidEdges(b, "add", hasMultiAddBases && b.id ? b.id : "base_solid");
	const prismBases = baseExtrusions.filter((b) => b.shape === "prism" && b.prismPolygon && b.prismPolygon.length >= 3);
	if (prismBases.length >= 2) {
		const pA = prismBases[0];
		const pB = prismBases[1];
		const getLinearSegments = (p) => {
			if (p.prismSegments && p.prismSegments.length > 0) return p.prismSegments.filter((s) => s.kind === "line").map((s) => ({
				p1: s.p1,
				p2: s.p2
			}));
			const pts = p.prismPolygon || [];
			return pts.map((pt, idx) => ({
				p1: pt,
				p2: pts[(idx + 1) % pts.length]
			}));
		};
		const segsA = getLinearSegments(pA);
		const segsB = getLinearSegments(pB);
		for (const s1 of segsA) for (const s2 of segsB) if (pA.prismAxis === "Y" && pB.prismAxis === "Z" || pA.prismAxis === "Z" && pB.prismAxis === "Y") {
			const fSeg = pA.prismAxis === "Y" ? s1 : s2;
			const tSeg = pA.prismAxis === "Z" ? s1 : s2;
			const dxF = fSeg.p2.u - fSeg.p1.u;
			const dxT = tSeg.p2.u - tSeg.p1.u;
			if (Math.abs(dxF) > .5 && Math.abs(dxT) > .5) {
				const xOverlap1 = Math.max(Math.min(fSeg.p1.u, fSeg.p2.u), Math.min(tSeg.p1.u, tSeg.p2.u));
				const xOverlap2 = Math.min(Math.max(fSeg.p1.u, fSeg.p2.u), Math.max(tSeg.p1.u, tSeg.p2.u));
				if (xOverlap2 - xOverlap1 > .5) {
					const zAt = (x) => fSeg.p1.v + (x - fSeg.p1.u) / dxF * (fSeg.p2.v - fSeg.p1.v);
					const yAt = (x) => tSeg.p1.v + (x - tSeg.p1.u) / dxT * (tSeg.p2.v - tSeg.p1.v);
					lines3D.push({
						p1: {
							x: xOverlap1,
							y: yAt(xOverlap1),
							z: zAt(xOverlap1)
						},
						p2: {
							x: xOverlap2,
							y: yAt(xOverlap2),
							z: zAt(xOverlap2)
						},
						ownerType: "add",
						ownerId: "base_solid",
						featureId: "custom_main",
						featureLabel: "Oblique Intersection Edge"
					});
				}
			}
		} else if (pA.prismAxis === "Y" && pB.prismAxis === "X" || pA.prismAxis === "X" && pB.prismAxis === "Y") {
			const fSeg = pA.prismAxis === "Y" ? s1 : s2;
			const lSeg = pA.prismAxis === "X" ? s1 : s2;
			const dzF = fSeg.p2.v - fSeg.p1.v;
			const dzL = lSeg.p2.v - lSeg.p1.v;
			if (Math.abs(dzF) > .5 && Math.abs(dzL) > .5) {
				const zOverlap1 = Math.max(Math.min(fSeg.p1.v, fSeg.p2.v), Math.min(lSeg.p1.v, lSeg.p2.v));
				const zOverlap2 = Math.min(Math.max(fSeg.p1.v, fSeg.p2.v), Math.max(lSeg.p1.v, lSeg.p2.v));
				if (zOverlap2 - zOverlap1 > .5) {
					const xAt = (z) => fSeg.p1.u + (z - fSeg.p1.v) / dzF * (fSeg.p2.u - fSeg.p1.u);
					const yAt = (z) => lSeg.p1.u + (z - lSeg.p1.v) / dzL * (lSeg.p2.u - lSeg.p1.u);
					lines3D.push({
						p1: {
							x: xAt(zOverlap1),
							y: yAt(zOverlap1),
							z: zOverlap1
						},
						p2: {
							x: xAt(zOverlap2),
							y: yAt(zOverlap2),
							z: zOverlap2
						},
						ownerType: "add",
						ownerId: "base_solid",
						featureId: "custom_main",
						featureLabel: "Oblique Intersection Edge"
					});
				}
			}
		} else if (pA.prismAxis === "Z" && pB.prismAxis === "X" || pA.prismAxis === "X" && pB.prismAxis === "Z") {
			const tSeg = pA.prismAxis === "Z" ? s1 : s2;
			const lSeg = pA.prismAxis === "X" ? s1 : s2;
			const dyT = tSeg.p2.v - tSeg.p1.v;
			const dyL = lSeg.p2.u - lSeg.p1.u;
			if (Math.abs(dyT) > .5 && Math.abs(dyL) > .5) {
				const yOverlap1 = Math.max(Math.min(tSeg.p1.v, tSeg.p2.v), Math.min(lSeg.p1.u, lSeg.p2.u));
				const yOverlap2 = Math.min(Math.max(tSeg.p1.v, tSeg.p2.v), Math.max(lSeg.p1.u, lSeg.p2.u));
				if (yOverlap2 - yOverlap1 > .5) {
					const xAt = (y) => tSeg.p1.u + (y - tSeg.p1.v) / dyT * (tSeg.p2.u - tSeg.p1.u);
					const zAt = (y) => lSeg.p1.v + (y - lSeg.p1.u) / dyL * (lSeg.p2.v - lSeg.p1.v);
					lines3D.push({
						p1: {
							x: xAt(yOverlap1),
							y: yOverlap1,
							z: zAt(yOverlap1)
						},
						p2: {
							x: xAt(yOverlap2),
							y: yOverlap2,
							z: zAt(yOverlap2)
						},
						ownerType: "add",
						ownerId: "base_solid",
						featureId: "custom_main",
						featureLabel: "Oblique Intersection Edge"
					});
				}
			}
		}
	}
	for (const boss of bossSolids) dispatchSolidEdges(boss, "add", boss.id);
	for (const sub of subSolids) dispatchSolidEdges(sub, "subtract", sub.id);
	const allSpheres = [...baseExtrusions.filter((b) => b.shape === "sphere" || b.shape === "hemisphere").map((b) => ({
		prim: b,
		ownerType: "add",
		ownerId: "base_solid"
	})), ...bossSolids.filter((b) => b.shape === "sphere" || b.shape === "hemisphere").map((b) => ({
		prim: b,
		ownerType: "add",
		ownerId: b.id
	}))];
	const allCylinders = [
		...baseExtrusions.filter((b) => b.shape.startsWith("cylinder_")).map((b) => ({
			prim: b,
			ownerType: "add",
			ownerId: "base_solid"
		})),
		...bossSolids.filter((b) => b.shape.startsWith("cylinder_")).map((b) => ({
			prim: b,
			ownerType: "add",
			ownerId: b.id
		})),
		...subSolids.filter((b) => b.shape.startsWith("cylinder_")).map((b) => ({
			prim: b,
			ownerType: "subtract",
			ownerId: b.id
		}))
	];
	const allPlanarSolids = [
		...baseExtrusions.filter((b) => b.shape === "box" || b.shape === "prism").map((b) => ({
			prim: b,
			ownerType: "add" as const,
			ownerId: "base_solid"
		})),
		...bossSolids.filter((b) => b.shape === "box" || b.shape === "prism").map((b) => ({
			prim: b,
			ownerType: "add" as const,
			ownerId: b.id
		})),
		...subSolids.filter((b) => b.shape === "box" || b.shape === "prism").map((b) => ({
			prim: b,
			ownerType: "subtract" as const,
			ownerId: b.id
		}))
	];
	for (const sphItem of allSpheres) {
		const sph = sphItem.prim;
		const R = sph.radius ?? .5 * (sph.xMax - sph.xMin);
		const sx = sph.centerX ?? .5 * (sph.xMin + sph.xMax);
		const sy = sph.centerY ?? .5 * (sph.yMin + sph.yMax);
		const sz = sph.centerZ ?? .5 * (sph.zMin + sph.zMax);
		for (const plItem of allPlanarSolids) {
			const pl = plItem.prim;
			const ownerType = plItem.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = plItem.ownerType === "subtract" ? plItem.ownerId : "base_solid";
			for (const xVal of [pl.xMin, pl.xMax]) {
				const d = Math.abs(xVal - sx);
				if (d < R - .2) {
					const rCut = Math.sqrt(R * R - d * d);
					if (targetView === "left") circles3D.push({
						center: {
							x: xVal,
							y: sy,
							z: sz
						},
						radius: rCut,
						axis: "X",
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
					else for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "front" ? {
							x: xVal,
							y: sy,
							z: sz - rCut
						} : {
							x: xVal,
							y: sy - rCut,
							z: sz
						},
						p2: targetView === "front" ? {
							x: xVal,
							y: sy,
							z: sz + rCut
						} : {
							x: xVal,
							y: sy + rCut,
							z: sz
						},
						evalPt3D: (t) => {
							const u = -rCut + 2 * rCut * t;
							const v = Math.sqrt(Math.max(0, rCut * rCut - u * u));
							return targetView === "front" ? {
								x: xVal,
								y: sy + sideSign * v,
								z: sz + u
							} : {
								x: xVal,
								y: sy + u,
								z: sz + sideSign * v
							};
						},
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
				}
			}
			for (const yVal of [pl.yMin, pl.yMax]) {
				const d = Math.abs(yVal - sy);
				if (d < R - .2) {
					const rCut = Math.sqrt(R * R - d * d);
					if (targetView === "front") circles3D.push({
						center: {
							x: sx,
							y: yVal,
							z: sz
						},
						radius: rCut,
						axis: "Y",
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
					else for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "top" ? {
							x: sx - rCut,
							y: yVal,
							z: sz
						} : {
							x: sx,
							y: yVal,
							z: sz - rCut
						},
						p2: targetView === "top" ? {
							x: sx + rCut,
							y: yVal,
							z: sz
						} : {
							x: sx,
							y: yVal,
							z: sz + rCut
						},
						evalPt3D: (t) => {
							const u = -rCut + 2 * rCut * t;
							const v = Math.sqrt(Math.max(0, rCut * rCut - u * u));
							return targetView === "top" ? {
								x: sx + u,
								y: yVal,
								z: sz + sideSign * v
							} : {
								x: sx + sideSign * v,
								y: yVal,
								z: sz + u
							};
						},
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
				}
			}
			for (const zVal of [pl.zMin, pl.zMax]) {
				const d = Math.abs(zVal - sz);
				if (d < R - .2) {
					const rCut = Math.sqrt(R * R - d * d);
					if (targetView === "top") circles3D.push({
						center: {
							x: sx,
							y: sy,
							z: zVal
						},
						radius: rCut,
						axis: "Z",
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
					else for (const sideSign of [-1, 1]) lines3D.push({
						p1: targetView === "front" ? {
							x: sx - rCut,
							y: sy,
							z: zVal
						} : {
							x: sx,
							y: sy - rCut,
							z: zVal
						},
						p2: targetView === "front" ? {
							x: sx + rCut,
							y: sy,
							z: zVal
						} : {
							x: sx,
							y: sy + rCut,
							z: zVal
						},
						evalPt3D: (t) => {
							const u = -rCut + 2 * rCut * t;
							const v = Math.sqrt(Math.max(0, rCut * rCut - u * u));
							return targetView === "front" ? {
								x: sx + u,
								y: sy + sideSign * v,
								z: zVal
							} : {
								x: sx + sideSign * v,
								y: sy + u,
								z: zVal
							};
						},
						ownerType,
						ownerId,
						featureId: pl.featureId,
						featureLabel: pl.label
					});
				}
			}
		}
		for (const cylItem of allCylinders) {
			const cyl = cylItem.prim;
			const rCyl = cyl.radius ?? .5 * (cyl.xMax - cyl.xMin);
			if (rCyl >= R - .2) continue;
			const dCut = Math.sqrt(R * R - rCyl * rCyl);
			const ownerType = cylItem.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = cylItem.ownerType === "subtract" ? cylItem.ownerId : "base_solid";
			if (cyl.shape === "cylinder_z" && Math.hypot((cyl.centerX ?? sx) - sx, (cyl.centerY ?? sy) - sy) <= 1.5) for (const zVal of [sz - dCut, sz + dCut]) if (targetView === "top") circles3D.push({
				center: {
					x: sx,
					y: sy,
					z: zVal
				},
				radius: rCyl,
				axis: "Z",
				ownerType,
				ownerId,
				featureId: ownerId
			});
			else lines3D.push({
				p1: targetView === "front" ? {
					x: sx - rCyl,
					y: sy,
					z: zVal
				} : {
					x: sx,
					y: sy - rCyl,
					z: zVal
				},
				p2: targetView === "front" ? {
					x: sx + rCyl,
					y: sy,
					z: zVal
				} : {
					x: sx,
					y: sy + rCyl,
					z: zVal
				},
				ownerType,
				ownerId,
				featureId: ownerId
			});
			else if (cyl.shape === "cylinder_y" && Math.hypot((cyl.centerX ?? sx) - sx, (cyl.centerZ ?? sz) - sz) <= 1.5) for (const yVal of [sy - dCut, sy + dCut]) if (targetView === "front") circles3D.push({
				center: {
					x: sx,
					y: yVal,
					z: sz
				},
				radius: rCyl,
				axis: "Y",
				ownerType,
				ownerId,
				featureId: ownerId
			});
			else lines3D.push({
				p1: targetView === "top" ? {
					x: sx - rCyl,
					y: yVal,
					z: sz
				} : {
					x: sx,
					y: yVal,
					z: sz - rCyl
				},
				p2: targetView === "top" ? {
					x: sx + rCyl,
					y: yVal,
					z: sz
				} : {
					x: sx,
					y: yVal,
					z: sz + rCyl
				},
				ownerType,
				ownerId,
				featureId: ownerId
			});
			else if (cyl.shape === "cylinder_x" && Math.hypot((cyl.centerY ?? sy) - sy, (cyl.centerZ ?? sz) - sz) <= 1.5) for (const xVal of [sx - dCut, sx + dCut]) if (targetView === "left") circles3D.push({
				center: {
					x: xVal,
					y: sy,
					z: sz
				},
				radius: rCyl,
				axis: "X",
				ownerType,
				ownerId,
				featureId: ownerId
			});
			else lines3D.push({
				p1: targetView === "front" ? {
					x: xVal,
					y: sy,
					z: sz - rCyl
				} : {
					x: xVal,
					y: sy - rCyl,
					z: sz
				},
				p2: targetView === "front" ? {
					x: xVal,
					y: sy,
					z: sz + rCyl
				} : {
					x: xVal,
					y: sy + rCyl,
					z: sz
				},
				ownerType,
				ownerId,
				featureId: ownerId
			});
		}
	}
	for (const cylItem of allCylinders) {
		const cyl = cylItem.prim;
		const r = cyl.radius ?? .5 * (cyl.xMax - cyl.xMin);
		for (const plItem of allPlanarSolids) {
			const pl = plItem.prim;
			const ownerType = cylItem.ownerType === "subtract" || plItem.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = plItem.ownerType === "subtract" ? plItem.ownerId : cylItem.ownerType === "subtract" ? cylItem.ownerId : "base_solid";
			const secondOwnerId = cylItem.ownerType === "subtract" && plItem.ownerType === "subtract" ? cylItem.ownerId === ownerId ? plItem.ownerId : cylItem.ownerId : void 0;
			const featureId = pl.featureId || cyl.featureId;
			if (cyl.shape === "cylinder_z") {
				const cx = cyl.centerX ?? .5 * (cyl.xMin + cyl.xMax);
				const cy = cyl.centerY ?? .5 * (cyl.yMin + cyl.yMax);
				const z1 = Math.max(cyl.zMin, pl.zMin);
				const z2 = Math.min(cyl.zMax, pl.zMax);
				if (z2 > z1) {
					for (const xVal of [pl.xMin, pl.xMax]) {
						const dx = xVal - cx;
						if (Math.abs(dx) < r - .001) {
							const dy = Math.sqrt(r * r - dx * dx);
							for (const yInt of [cy - dy, cy + dy]) lines3D.push({
								p1: {
									x: xVal,
									y: yInt,
									z: z1
								},
								p2: {
									x: xVal,
									y: yInt,
									z: z2
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const yVal of [pl.yMin, pl.yMax]) {
						const dy = yVal - cy;
						if (Math.abs(dy) < r - .001) {
							const dx = Math.sqrt(r * r - dy * dy);
							for (const xInt of [cx - dx, cx + dx]) lines3D.push({
								p1: {
									x: xInt,
									y: yVal,
									z: z1
								},
								p2: {
									x: xInt,
									y: yVal,
									z: z2
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const zVal of [pl.zMin, pl.zMax]) if (zVal > cyl.zMin + .1 && zVal < cyl.zMax - .1) {
						if (targetView === "top") circles3D.push({
							center: {
								x: cx,
								y: cy,
								z: zVal
							},
							radius: r,
							axis: "Z",
							ownerType,
							ownerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "front") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: cx - r,
								y: cy,
								z: zVal
							},
							p2: {
								x: cx + r,
								y: cy,
								z: zVal
							},
							evalPt3D: (t) => {
								const x = cx - r + 2 * r * t;
								const dy = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
								return {
									x,
									y: cy + sideSign * dy,
									z: zVal
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "left") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: cx,
								y: cy - r,
								z: zVal
							},
							p2: {
								x: cx,
								y: cy + r,
								z: zVal
							},
							evalPt3D: (t) => {
								const y = cy - r + 2 * r * t;
								const dx = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy)));
								return {
									x: cx + sideSign * dx,
									y,
									z: zVal
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
					}
				}
			} else if (cyl.shape === "cylinder_y") {
				const cx = cyl.centerX ?? .5 * (cyl.xMin + cyl.xMax);
				const cz = cyl.centerZ ?? .5 * (cyl.zMin + cyl.zMax);
				const y1 = Math.max(cyl.yMin, pl.yMin);
				const y2 = Math.min(cyl.yMax, pl.yMax);
				if (y2 > y1) {
					for (const xVal of [pl.xMin, pl.xMax]) {
						const dx = xVal - cx;
						if (Math.abs(dx) < r - .001) {
							const dz = Math.sqrt(r * r - dx * dx);
							for (const zInt of [cz - dz, cz + dz]) lines3D.push({
								p1: {
									x: xVal,
									y: y1,
									z: zInt
								},
								p2: {
									x: xVal,
									y: y2,
									z: zInt
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const zVal of [pl.zMin, pl.zMax]) {
						const dz = zVal - cz;
						if (Math.abs(dz) < r - .001) {
							const dx = Math.sqrt(r * r - dz * dz);
							for (const xInt of [cx - dx, cx + dx]) lines3D.push({
								p1: {
									x: xInt,
									y: y1,
									z: zVal
								},
								p2: {
									x: xInt,
									y: y2,
									z: zVal
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const yVal of [pl.yMin, pl.yMax]) if (yVal > cyl.yMin + .1 && yVal < cyl.yMax - .1) {
						if (targetView === "front") circles3D.push({
							center: {
								x: cx,
								y: yVal,
								z: cz
							},
							radius: r,
							axis: "Y",
							ownerType,
							ownerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "top") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: cx - r,
								y: yVal,
								z: cz
							},
							p2: {
								x: cx + r,
								y: yVal,
								z: cz
							},
							evalPt3D: (t) => {
								const x = cx - r + 2 * r * t;
								const dz = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
								return {
									x,
									y: yVal,
									z: cz + sideSign * dz
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "left") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: cx,
								y: yVal,
								z: cz - r
							},
							p2: {
								x: cx,
								y: yVal,
								z: cz + r
							},
							evalPt3D: (t) => {
								const z = cz - r + 2 * r * t;
								const dx = Math.sqrt(Math.max(0, r * r - (z - cz) * (z - cz)));
								return {
									x: cx + sideSign * dx,
									y: yVal,
									z
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
					}
				}
			} else if (cyl.shape === "cylinder_x") {
				const cy = cyl.centerY ?? .5 * (cyl.yMin + cyl.yMax);
				const cz = cyl.centerZ ?? .5 * (cyl.zMin + cyl.zMax);
				const x1 = Math.max(cyl.xMin, pl.xMin);
				const x2 = Math.min(cyl.xMax, pl.xMax);
				if (x2 > x1) {
					for (const yVal of [pl.yMin, pl.yMax]) {
						const dy = yVal - cy;
						if (Math.abs(dy) < r - .001) {
							const dz = Math.sqrt(r * r - dy * dy);
							for (const zInt of [cz - dz, cz + dz]) lines3D.push({
								p1: {
									x: x1,
									y: yVal,
									z: zInt
								},
								p2: {
									x: x2,
									y: yVal,
									z: zInt
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const zVal of [pl.zMin, pl.zMax]) {
						const dz = zVal - cz;
						if (Math.abs(dz) < r - .001) {
							const dy = Math.sqrt(r * r - dz * dz);
							for (const yInt of [cy - dy, cy + dy]) lines3D.push({
								p1: {
									x: x1,
									y: yInt,
									z: zVal
								},
								p2: {
									x: x2,
									y: yInt,
									z: zVal
								},
								ownerType,
								ownerId,
								secondOwnerId,
								featureId,
								featureLabel: pl.label
							});
						}
					}
					for (const xVal of [pl.xMin, pl.xMax]) if (xVal > cyl.xMin + .1 && xVal < cyl.xMax - .1) {
						if (targetView === "left") circles3D.push({
							center: {
								x: xVal,
								y: cy,
								z: cz
							},
							radius: r,
							axis: "X",
							ownerType,
							ownerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "front") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: xVal,
								y: cy,
								z: cz - r
							},
							p2: {
								x: xVal,
								y: cy,
								z: cz + r
							},
							evalPt3D: (t) => {
								const z = cz - r + 2 * r * t;
								const dy = Math.sqrt(Math.max(0, r * r - (z - cz) * (z - cz)));
								return {
									x: xVal,
									y: cy + sideSign * dy,
									z
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
						else if (targetView === "top") for (const sideSign of [-1, 1]) lines3D.push({
							p1: {
								x: xVal,
								y: cy - r,
								z: cz
							},
							p2: {
								x: xVal,
								y: cy + r,
								z: cz
							},
							evalPt3D: (t) => {
								const y = cy - r + 2 * r * t;
								const dz = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy)));
								return {
									x: xVal,
									y,
									z: cz + sideSign * dz
								};
							},
							ownerType,
							ownerId,
							secondOwnerId,
							featureId,
							featureLabel: pl.label
						});
					}
				}
			}
		}
	}
	const allBarrels = [];
	for (const cylItem of allCylinders) {
		const c = cylItem.prim;
		const r = c.radius ?? .5 * (c.xMax - c.xMin);
		if (c.shape === "cylinder_z") allBarrels.push({
			primId: c.id,
			axis: "Z",
			centerU: c.centerX ?? .5 * (c.xMin + c.xMax),
			centerV: c.centerY ?? .5 * (c.yMin + c.yMax),
			radius: r,
			wMin: c.zMin,
			wMax: c.zMax,
			isArc: false,
			ownerType: cylItem.ownerType,
			ownerId: cylItem.ownerId,
			featureId: c.featureId,
			featureLabel: c.label
		});
		else if (c.shape === "cylinder_y") allBarrels.push({
			primId: c.id,
			axis: "Y",
			centerU: c.centerX ?? .5 * (c.xMin + c.xMax),
			centerV: c.centerZ ?? .5 * (c.zMin + c.zMax),
			radius: r,
			wMin: c.yMin,
			wMax: c.yMax,
			isArc: false,
			ownerType: cylItem.ownerType,
			ownerId: cylItem.ownerId,
			featureId: c.featureId,
			featureLabel: c.label
		});
		else if (c.shape === "cylinder_x") allBarrels.push({
			primId: c.id,
			axis: "X",
			centerU: c.centerY ?? .5 * (c.yMin + c.yMax),
			centerV: c.centerZ ?? .5 * (c.zMin + c.zMax),
			radius: r,
			wMin: c.xMin,
			wMax: c.xMax,
			isArc: false,
			ownerType: cylItem.ownerType,
			ownerId: cylItem.ownerId,
			featureId: c.featureId,
			featureLabel: c.label
		});
	}
	for (const plItem of allPlanarSolids) {
		const pl = plItem.prim;
		if (pl.shape === "prism" && pl.prismSegments) {
			const axis = pl.prismAxis || "Y";
			const wMin = axis === "Z" ? pl.zMin : axis === "Y" ? pl.yMin : pl.xMin;
			const wMax = axis === "Z" ? pl.zMax : axis === "Y" ? pl.yMax : pl.xMax;
			for (const seg of pl.prismSegments) if (seg.kind === "arc" && seg.center && seg.radius !== void 0 && seg.startAngle !== void 0 && seg.endAngle !== void 0) allBarrels.push({
				primId: pl.id,
				axis,
				centerU: seg.center.u,
				centerV: seg.center.v,
				radius: seg.radius,
				wMin,
				wMax,
				isArc: true,
				startAngle: seg.startAngle,
				endAngle: seg.endAngle,
				ownerType: plItem.ownerType,
				ownerId: plItem.ownerId,
				featureId: pl.featureId,
				featureLabel: pl.label
			});
		}
	}
	// Plane-ArcBarrel SSI: intersect planar box walls (e.g. vertical square hole X=55, 65) with prism arc barrels (e.g. top arch R=20)
	for (const b of allBarrels) {
		if (!b.isArc || b.startAngle === void 0 || b.endAngle === void 0) continue;
		const R = b.radius;
		for (const plItem of allPlanarSolids) {
			const pl = plItem.prim;
			if (pl.id === b.primId) continue;
			const ownerType = plItem.ownerType === "subtract" || b.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = plItem.ownerType === "subtract" ? plItem.ownerId : b.ownerType === "subtract" ? b.ownerId : plItem.ownerId;
			const secondOwnerId = plItem.ownerType === "subtract" && b.ownerType === "subtract" ? b.ownerId : plItem.ownerType === "add" && b.ownerType === "add" ? b.ownerId : void 0;
			const featureId = plItem.ownerType === "subtract" ? pl.featureId : b.featureId || pl.featureId;
			const featureLabel = plItem.ownerType === "subtract" ? pl.label : b.featureLabel || pl.label;
			if (b.axis === "Y") {
				const y1 = Math.max(b.wMin, pl.yMin);
				const y2 = Math.min(b.wMax, pl.yMax);
				if (y2 <= y1) continue;
				for (const xVal of [pl.xMin, pl.xMax]) {
					const dx = xVal - b.centerU;
					if (Math.abs(dx) < R - 0.001) {
						const dz = Math.sqrt(R * R - dx * dx);
						for (const zInt of [b.centerV - dz, b.centerV + dz]) {
							if (zInt >= pl.zMin - 0.1 && zInt <= pl.zMax + 0.1 && isAngleOnArc(Math.atan2(zInt - b.centerV, xVal - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: xVal, y: y1, z: zInt },
									p2: { x: xVal, y: y2, z: zInt },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
				for (const zVal of [pl.zMin, pl.zMax]) {
					const dz = zVal - b.centerV;
					if (Math.abs(dz) < R - 0.001) {
						const dx = Math.sqrt(R * R - dz * dz);
						for (const xInt of [b.centerU - dx, b.centerU + dx]) {
							if (xInt >= pl.xMin - 0.1 && xInt <= pl.xMax + 0.1 && isAngleOnArc(Math.atan2(zVal - b.centerV, xInt - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: xInt, y: y1, z: zVal },
									p2: { x: xInt, y: y2, z: zVal },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
			} else if (b.axis === "Z") {
				const z1 = Math.max(b.wMin, pl.zMin);
				const z2 = Math.min(b.wMax, pl.zMax);
				if (z2 <= z1) continue;
				for (const xVal of [pl.xMin, pl.xMax]) {
					const dx = xVal - b.centerU;
					if (Math.abs(dx) < R - 0.001) {
						const dy = Math.sqrt(R * R - dx * dx);
						for (const yInt of [b.centerV - dy, b.centerV + dy]) {
							if (yInt >= pl.yMin - 0.1 && yInt <= pl.yMax + 0.1 && isAngleOnArc(Math.atan2(yInt - b.centerV, xVal - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: xVal, y: yInt, z: z1 },
									p2: { x: xVal, y: yInt, z: z2 },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
				for (const yVal of [pl.yMin, pl.yMax]) {
					const dy = yVal - b.centerV;
					if (Math.abs(dy) < R - 0.001) {
						const dx = Math.sqrt(R * R - dy * dy);
						for (const xInt of [b.centerU - dx, b.centerU + dx]) {
							if (xInt >= pl.xMin - 0.1 && xInt <= pl.xMax + 0.1 && isAngleOnArc(Math.atan2(yVal - b.centerV, xInt - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: xInt, y: yVal, z: z1 },
									p2: { x: xInt, y: yVal, z: z2 },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
			} else if (b.axis === "X") {
				const x1 = Math.max(b.wMin, pl.xMin);
				const x2 = Math.min(b.wMax, pl.xMax);
				if (x2 <= x1) continue;
				for (const yVal of [pl.yMin, pl.yMax]) {
					const dy = yVal - b.centerU;
					if (Math.abs(dy) < R - 0.001) {
						const dz = Math.sqrt(R * R - dy * dy);
						for (const zInt of [b.centerV - dz, b.centerV + dz]) {
							if (zInt >= pl.zMin - 0.1 && zInt <= pl.zMax + 0.1 && isAngleOnArc(Math.atan2(zInt - b.centerV, yVal - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: x1, y: yVal, z: zInt },
									p2: { x: x2, y: yVal, z: zInt },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
				for (const zVal of [pl.zMin, pl.zMax]) {
					const dz = zVal - b.centerV;
					if (Math.abs(dz) < R - 0.001) {
						const dy = Math.sqrt(R * R - dz * dz);
						for (const yInt of [b.centerU - dy, b.centerU + dy]) {
							if (yInt >= pl.yMin - 0.1 && yInt <= pl.yMax + 0.1 && isAngleOnArc(Math.atan2(zVal - b.centerV, yInt - b.centerU), b.startAngle, b.endAngle, -0.02)) {
								lines3D.push({
									p1: { x: x1, y: yInt, z: zVal },
									p2: { x: x2, y: yInt, z: zVal },
									isSilhouette: false,
									ownerType,
									ownerId,
									secondOwnerId,
									featureId,
									featureLabel
								});
							}
						}
					}
				}
			}
		}
	}
	const getBarrelCenterAlong = (b, coord) => {
		if (b.axis === "Z") return coord === "X" ? b.centerU : b.centerV;
		if (b.axis === "Y") return coord === "X" ? b.centerU : b.centerV;
		return coord === "Y" ? b.centerU : b.centerV;
	};
	const isPointOnBarrel = (b, pt) => {
		const w = b.axis === "Z" ? pt.z : b.axis === "Y" ? pt.y : pt.x;
		if (w < b.wMin - .25 || w > b.wMax + .25) return false;
		if (!b.isArc || b.startAngle === void 0 || b.endAngle === void 0) return true;
		const u = b.axis === "Z" ? pt.x : b.axis === "Y" ? pt.x : pt.y;
		const v = b.axis === "Z" ? pt.y : b.axis === "Y" ? pt.z : pt.z;
		return isAngleOnArc(Math.atan2(v - b.centerV, u - b.centerU), b.startAngle, b.endAngle, .02);
	};
	for (let i = 0; i < allBarrels.length; i++) for (let j = i + 1; j < allBarrels.length; j++) {
		const bA = allBarrels[i];
		const bB = allBarrels[j];
		if (bA.axis === bB.axis) continue;
		const b1 = bA.radius <= bB.radius ? bA : bB;
		const b2 = bA.radius <= bB.radius ? bB : bA;
		const A1 = b1.axis;
		const A2 = b2.axis;
		const Q = A1 !== "X" && A2 !== "X" ? "X" : A1 !== "Y" && A2 !== "Y" ? "Y" : "Z";
		if (targetView !== (Q === "X" ? "left" : Q === "Y" ? "front" : "top")) continue;
		const q1 = getBarrelCenterAlong(b1, Q);
		const a2_1 = getBarrelCenterAlong(b1, A2);
		const q2 = getBarrelCenterAlong(b2, Q);
		const a1_2 = getBarrelCenterAlong(b2, A1);
		const r1 = b1.radius;
		const R2 = b2.radius;
		if (Math.max(q1 - r1, q2 - R2) >= Math.min(q1 + r1, q2 + R2) - .1) continue;
		const ownerType = b1.ownerType === "subtract" || b2.ownerType === "subtract" ? "subtract" : "add";
		const ownerId = b1.ownerType === "subtract" ? b1.ownerId : b2.ownerType === "subtract" ? b2.ownerId : b1.ownerId;
		const secondOwnerId = b1.ownerType === "subtract" && b2.ownerType === "subtract" ? b2.ownerId : b1.ownerType === "add" && b2.ownerType === "add" ? b2.ownerId : void 0;
		const featureId = b1.ownerType === "subtract" ? b1.featureId : b2.featureId || b1.featureId;
		const featureLabel = b1.ownerType === "subtract" ? b1.featureLabel : b2.featureLabel || b1.featureLabel;
		const buildVec3 = (qVal, a1Val, a2Val) => {
			const res = {
				x: 0,
				y: 0,
				z: 0
			};
			if (Q === "X") res.x = qVal;
			else if (Q === "Y") res.y = qVal;
			else res.z = qVal;
			if (A1 === "X") res.x = a1Val;
			else if (A1 === "Y") res.y = a1Val;
			else res.z = a1Val;
			if (A2 === "X") res.x = a2Val;
			else if (A2 === "Y") res.y = a2Val;
			else res.z = a2Val;
			return res;
		};
		const isSymmetricQ = Math.abs(q1 - q2) <= .25;
		const N_STEPS = 64;
		for (const sA1 of [-1, 1]) if (isSymmetricQ) {
			const samples = [];
			for (let k = 0; k <= N_STEPS; k++) {
				const alpha = -Math.PI * .5 + k / N_STEPS * Math.PI;
				const a2Val = a2_1 + r1 * Math.sin(alpha);
				const qNeg = q1 - r1 * Math.cos(alpha);
				const qPos = q1 + r1 * Math.cos(alpha);
				const dq = qNeg - q2;
				if (Math.abs(dq) > R2) continue;
				const a1Val = a1_2 + sA1 * Math.sqrt(Math.max(0, R2 * R2 - dq * dq));
				const pNeg = buildVec3(qNeg, a1Val, a2Val);
				const pPos = buildVec3(qPos, a1Val, a2Val);
				const negValid = isPointOnBarrel(b1, pNeg) && isPointOnBarrel(b2, pNeg);
				const posValid = isPointOnBarrel(b1, pPos) && isPointOnBarrel(b2, pPos);
				if (negValid || posValid) samples.push({
					pNeg: negValid ? pNeg : pPos,
					pPos: posValid ? pPos : pNeg
				});
			}
			if (samples.length >= 3) curves3D.push({
				samples,
				ownerType,
				ownerId,
				secondOwnerId,
				featureId,
				featureLabel
			});
		} else for (const sQ of [-1, 1]) {
			const samples = [];
			for (let k = 0; k <= N_STEPS; k++) {
				const alpha = -Math.PI * .5 + k / N_STEPS * Math.PI;
				const a2Val = a2_1 + r1 * Math.sin(alpha);
				const qVal = q1 + sQ * r1 * Math.cos(alpha);
				const dq = qVal - q2;
				if (Math.abs(dq) > R2) continue;
				const pt = buildVec3(qVal, a1_2 + sA1 * Math.sqrt(Math.max(0, R2 * R2 - dq * dq)), a2Val);
				if (isPointOnBarrel(b1, pt) && isPointOnBarrel(b2, pt)) samples.push({
					pNeg: pt,
					pPos: pt
				});
			}
			if (samples.length >= 3) curves3D.push({
				samples,
				ownerType,
				ownerId,
				secondOwnerId,
				featureId,
				featureLabel
			});
		}
	}
	const allCones = [
		...baseExtrusions.filter((b) => b.shape.startsWith("cone_")).map((b) => ({
			prim: b,
			ownerType: "add" as const,
			ownerId: "base_solid"
		})),
		...bossSolids.filter((b) => b.shape.startsWith("cone_")).map((b) => ({
			prim: b,
			ownerType: "add" as const,
			ownerId: b.id
		}))
	];
	for (const coneItem of allCones) {
		const cone = coneItem.prim;
		const A_cone = cone.shape === "cone_z" ? "Z" : cone.shape === "cone_y" ? "Y" : "X";
		const wMin = A_cone === "Z" ? cone.zMin : A_cone === "Y" ? cone.yMin : cone.xMin;
		const wMax = A_cone === "Z" ? cone.zMax : A_cone === "Y" ? cone.yMax : cone.xMax;
		const r0 = cone.rMin ?? cone.radius ?? 0;
		const r1 = cone.rMax ?? 0;
		const cxCone = cone.centerX ?? .5 * (cone.xMin + cone.xMax);
		const cyCone = cone.centerY ?? .5 * (cone.yMin + cone.yMax);
		const czCone = cone.centerZ ?? .5 * (cone.zMin + cone.zMax);
		const rConeAtW = (w: number) => {
			const t = Math.max(0, Math.min(1, (w - wMin) / Math.max(.001, wMax - wMin)));
			return (1 - t) * r0 + t * r1;
		};
		for (const cylItem of allCylinders) {
			const cyl = cylItem.prim;
			const A_cyl = cyl.shape === "cylinder_z" ? "Z" : cyl.shape === "cylinder_y" ? "Y" : "X";
			const rCyl = cyl.radius ?? .5 * (cyl.xMax - cyl.xMin);
			const cxCyl = cyl.centerX ?? .5 * (cyl.xMin + cyl.xMax);
			const cyCyl = cyl.centerY ?? .5 * (cyl.yMin + cyl.yMax);
			const czCyl = cyl.centerZ ?? .5 * (cyl.zMin + cyl.zMax);
			const ownerType = cylItem.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = cylItem.ownerType === "subtract" ? cylItem.ownerId : coneItem.ownerId;
			const featureId = cyl.featureId || cone.featureId;
			const featureLabel = cyl.label || cone.label;
			if (A_cone === A_cyl) continue;
			const Q = A_cone !== "X" && A_cyl !== "X" ? "X" : A_cone !== "Y" && A_cyl !== "Y" ? "Y" : "Z";
			const qCone = Q === "X" ? cxCone : Q === "Y" ? cyCone : czCone;
			const aCylCone = A_cyl === "X" ? cxCone : A_cyl === "Y" ? cyCone : czCone;
			const qCyl = Q === "X" ? cxCyl : Q === "Y" ? cyCyl : czCyl;
			const wCyl = A_cone === "X" ? cxCyl : A_cone === "Y" ? cyCyl : czCyl;
			const buildVec3 = (qVal: number, wVal: number, aCylVal: number) => {
				const res = {
					x: 0,
					y: 0,
					z: 0
				};
				if (Q === "X") res.x = qVal;
				else if (Q === "Y") res.y = qVal;
				else res.z = qVal;
				if (A_cone === "X") res.x = wVal;
				else if (A_cone === "Y") res.y = wVal;
				else res.z = wVal;
				if (A_cyl === "X") res.x = aCylVal;
				else if (A_cyl === "Y") res.y = aCylVal;
				else res.z = aCylVal;
				return res;
			};
			const N_STEPS = 120;
			const rawAlphas: number[] = [];
			for (let k = 0; k <= N_STEPS; k++) rawAlphas.push(-Math.PI * .5 + k / N_STEPS * Math.PI);
			const refinedAlphas: number[] = [];
			const evalMargin = (alpha: number, sQ: number) => {
				const wVal = wCyl + rCyl * Math.sin(alpha);
				const qVal = qCyl + sQ * rCyl * Math.cos(alpha);
				return rConeAtW(wVal) - Math.abs(qVal - qCone);
			};
			for (let k = 0; k < rawAlphas.length; k++) {
				const aCur = rawAlphas[k];
				refinedAlphas.push(aCur);
				if (k + 1 < rawAlphas.length) {
					const aNext = rawAlphas[k + 1];
					const wCur = wCyl + rCyl * Math.sin(aCur);
					const wNext = wCyl + rCyl * Math.sin(aNext);
					for (const wBound of [wMin, wMax]) if (wCur < wBound && wNext > wBound || wCur > wBound && wNext < wBound) {
						let lo = aCur;
						let hi = aNext;
						for (let it = 0; it < 10; it++) {
							const mid = .5 * (lo + hi);
							if (wCyl + rCyl * Math.sin(mid) < wBound === wCur < wBound) lo = mid;
							else hi = mid;
						}
						refinedAlphas.push(.5 * (lo + hi));
					}
					for (const sQ of [-1, 1]) {
						const mCur = evalMargin(aCur, sQ);
						const mNext = evalMargin(aNext, sQ);
						if (mCur < 0 && mNext >= 0 || mCur >= 0 && mNext < 0) {
							let lo = aCur;
							let hi = aNext;
							for (let it = 0; it < 10; it++) {
								const mid = .5 * (lo + hi);
								if (evalMargin(mid, sQ) < 0 === mCur < 0) lo = mid;
								else hi = mid;
							}
							refinedAlphas.push(.5 * (lo + hi));
						}
					}
				}
			}
			refinedAlphas.sort((a, b) => a - b);
			const isSymQ = Math.abs(qCyl - qCone) <= .25;
			for (const sA of [-1, 1]) if (isSymQ) {
				const samples = [];
				for (const alpha of refinedAlphas) {
					const wVal = wCyl + rCyl * Math.sin(alpha);
					if (wVal < wMin - .08 || wVal > wMax + .08) continue;
					const wClamped = Math.max(wMin, Math.min(wMax, wVal));
					const qNeg = qCyl - rCyl * Math.cos(alpha);
					const qPos = qCyl + rCyl * Math.cos(alpha);
					const dq = Math.abs(qNeg - qCone);
					const rC = rConeAtW(wClamped);
					if (dq > rC + .05) continue;
					const dz = Math.sqrt(Math.max(0, rC * rC - dq * dq));
					const aVal = aCylCone + sA * dz;
					samples.push({
						pNeg: buildVec3(qNeg, wClamped, aVal),
						pPos: buildVec3(qPos, wClamped, aVal)
					});
				}
				if (samples.length >= 2) curves3D.push({
					samples,
					ownerType,
					ownerId,
					featureId,
					featureLabel
				});
			} else for (const sQ of [-1, 1]) {
				const samples = [];
				for (const alpha of refinedAlphas) {
					const wVal = wCyl + rCyl * Math.sin(alpha);
					if (wVal < wMin - .08 || wVal > wMax + .08) continue;
					const wClamped = Math.max(wMin, Math.min(wMax, wVal));
					const qVal = qCyl + sQ * rCyl * Math.cos(alpha);
					const dq = Math.abs(qVal - qCone);
					const rC = rConeAtW(wClamped);
					if (dq > rC + .05) continue;
					const dz = Math.sqrt(Math.max(0, rC * rC - dq * dq));
					const pt = buildVec3(qVal, wClamped, aCylCone + sA * dz);
					samples.push({
						pNeg: pt,
						pPos: pt
					});
				}
				if (samples.length >= 2) curves3D.push({
					samples,
					ownerType,
					ownerId,
					featureId,
					featureLabel
				});
			}
		}
	}
	// Layer 4 Analytical Slanted Plane-Quadric Section Curves (Truncated Cylinders, Cones, Frustums, Spheres)
	const allCurvedItems = [...allCylinders, ...allCones, ...allSpheres];
	const allPrismAndPyramidItems = [
		...baseExtrusions.filter((b) => b.shape === "prism" || b.shape === "pyramid" || b.shape === "wedge_y").map((b) => ({
			prim: b,
			ownerType: "add" as const,
			ownerId: "base_solid"
		})),
		...subSolids.filter((b) => b.shape === "prism" || b.shape === "pyramid" || b.shape === "wedge_y").map((b) => ({
			prim: b,
			ownerType: "subtract" as const,
			ownerId: b.id
		}))
	];
	for (const plItem of allPrismAndPyramidItems) {
		const slantedPlanes = extractSlantedPlanesFromPrimitive(plItem.prim as any);
		if (slantedPlanes.length === 0) continue;
		for (const curItem of allCurvedItems) {
			if (curItem.prim.id === plItem.prim.id) continue;
			const ownerType = plItem.ownerType === "subtract" || curItem.ownerType === "subtract" ? "subtract" : "add";
			const ownerId = plItem.ownerType === "subtract" ? plItem.ownerId : curItem.ownerType === "subtract" ? curItem.ownerId : "base_solid";
			for (const sp of slantedPlanes) {
				const segs = computePlaneQuadricSectionSegments(sp, curItem.prim as any, [...baseExtrusions, ...bossSolids, ...subSolids] as any, 36);
				for (const seg of segs) {
					lines3D.push({
						p1: seg.p1,
						p2: seg.p2,
						ownerType,
						ownerId,
						featureId: plItem.prim.featureId || curItem.prim.featureId,
						featureLabel: plItem.prim.label || curItem.prim.label
					});
				}
			}
		}
	}
	return {
		lines3D,
		circles3D,
		curves3D
	};
}
/**
* 1D Collinear Interval Boolean Clipper & Priority Merger:
* Priority: thick_solid > thin_dashed > center_dot_dash
* Eliminates duplicate/overlapping segments and clips hidden lines under visible lines.
*/
export function clipAndMergeLinearSegments2D(rawLines, targetView) {
	const groups = [];
	const DIST_TOL = .35;
	const ANG_TOL = .015;
	for (const ln of rawLines) {
		const len = dist2D(ln.p1, ln.p2);
		if (len < .35) continue;
		let dx = (ln.p2.u - ln.p1.u) / len;
		let dy = (ln.p2.v - ln.p1.v) / len;
		if (dx < -1e-5 || Math.abs(dx) <= 1e-5 && dy < 0) {
			dx = -dx;
			dy = -dy;
		}
		const nx = -dy;
		const ny = dx;
		const c = nx * ln.p1.u + ny * ln.p1.v;
		let grp = groups.find((g) => Math.abs(g.dx * dx + g.dy * dy - 1) <= ANG_TOL && Math.abs(g.c - c) <= DIST_TOL);
		if (!grp) {
			grp = {
				nx,
				ny,
				dx,
				dy,
				c,
				origin: {
					u: nx * c,
					v: ny * c
				},
				intervals: []
			};
			groups.push(grp);
		}
		const tA = (ln.p1.u - grp.origin.u) * grp.dx + (ln.p1.v - grp.origin.v) * grp.dy;
		const tB = (ln.p2.u - grp.origin.u) * grp.dx + (ln.p2.v - grp.origin.v) * grp.dy;
		grp.intervals.push({
			t1: Math.min(tA, tB),
			t2: Math.max(tA, tB),
			lineType: ln.lineType,
			featureId: ln.featureId,
			featureLabel: ln.featureLabel
		});
	}
	const result = [];
	const priorityOf = (lt) => {
		if (lt === "thick_solid") return 3;
		if (lt === "thin_dashed") return 2;
		if (lt === "center_dot_dash") return 1;
		return 0;
	};
	for (const grp of groups) {
		const coords = [];
		for (const iv of grp.intervals) coords.push(iv.t1, iv.t2);
		coords.sort((a, b) => a - b);
		const uniqueT = [];
		for (const t of coords) if (uniqueT.length === 0 || t - uniqueT[uniqueT.length - 1] > .15) uniqueT.push(t);
		if (uniqueT.length < 2) continue;
		const spans = [];
		for (let i = 0; i < uniqueT.length - 1; i++) {
			const a = uniqueT[i];
			const b = uniqueT[i + 1];
			const mid = .5 * (a + b);
			let best = null;
			for (const iv of grp.intervals) if (iv.t1 <= mid + .05 && iv.t2 >= mid - .05) {
				if (!best || priorityOf(iv.lineType) > priorityOf(best.lineType)) best = iv;
			}
			if (best) spans.push({
				t1: a,
				t2: b,
				lineType: best.lineType,
				featureId: best.featureId,
				featureLabel: best.featureLabel
			});
		}
		const merged = [];
		for (const sp of spans) {
			const prev = merged[merged.length - 1];
			if (prev && prev.lineType === sp.lineType && sp.t1 - prev.t2 <= .35) prev.t2 = sp.t2;
			else merged.push({ ...sp });
		}
		for (const m of merged) {
			if (m.t2 - m.t1 < .45) continue;
			const p1 = {
				u: Number((grp.origin.u + grp.dx * m.t1).toFixed(2)),
				v: Number((grp.origin.v + grp.dy * m.t1).toFixed(2))
			};
			const p2 = {
				u: Number((grp.origin.u + grp.dx * m.t2).toFixed(2)),
				v: Number((grp.origin.v + grp.dy * m.t2).toFixed(2))
			};
			result.push({
				id: `derived-${targetView}-ln-${result.length}`,
				view: targetView,
				type: "line",
				lineType: m.lineType,
				p1,
				p2,
				source: "derived",
				featureId: m.featureId || "custom_main",
				featureLabel: m.featureLabel
			});
		}
	}
	return result;
}
/**
* Project a 3D CSG Solid onto a 2D Orthographic View using:
* - Step A: SDF Surface Survival + 6-Neighbor Real Surface Verification
* - Step B: Fine-Step Sightline Raycast Strict-Interior Occlusion
* - Step C: 1D Linear & Angular Interval Boolean Clippers + 3D Space Curve Projection
* - Step D: GB/T 4mm Extended Centerlines
*/
export function projectCSGSolidToView(targetView, primitives3D, bounds) {
	const validPrims = (primitives3D || []).filter(isValidPrimitive3D);
	const baseExtrusions = validPrims.filter((p) => p.operation === "intersect" || p.operation === "add" && !p.id.startsWith("boss-"));
	const bossSolids = validPrims.filter((p) => p.operation === "add" && p.id.startsWith("boss-"));
	const refBase = baseExtrusions[0];
	const subSolids = validPrims.filter((p) => p.operation === "subtract" && !(refBase && isFullBaseSubtract(p, refBase)));
	if (baseExtrusions.length === 0) return [];
	const { lines3D, circles3D, curves3D } = generateAllCandidate3DEdges(targetView, baseExtrusions, bossSolids, subSolids);
	const raw2DLines = [];
	const COARSE_STEP = 1.5;
	const addListAll = [...baseExtrusions.filter((p) => p.operation === "add"), ...bossSolids];
	const intListAll = baseExtrusions.filter((p) => p.operation === "intersect");
	const evalAddOnlySDF = (pt: { x: number; y: number; z: number }): number => {
		let dBase = Infinity;
		if (addListAll.length > 0 && intListAll.length === 0) {
			dBase = Math.min(...addListAll.map((p) => evalPrimitiveSDF(pt, p)));
		} else if (intListAll.length > 0) {
			dBase = Math.max(...intListAll.map((p) => evalPrimitiveSDF(pt, p)));
			if (addListAll.length > 0) {
				dBase = Math.min(dBase, ...addListAll.map((p) => evalPrimitiveSDF(pt, p)));
			}
		}
		return dBase;
	};
	const subPrimById = new Map<string, any>();
	for (const s of subSolids) subPrimById.set(s.id, s);
	const evalEdgeExactPt = (edge, t) => edge.evalPt3D ? edge.evalPt3D(t) : {
		x: edge.p1.x + (edge.p2.x - edge.p1.x) * t,
		y: edge.p1.y + (edge.p2.y - edge.p1.y) * t,
		z: edge.p1.z + (edge.p2.z - edge.p1.z) * t
	};
	const evalEdgeState = (edge, t) => {
		const pt = evalEdgeExactPt(edge, Math.min(.998, Math.max(.002, t)));
		if (edge.ownerType === "subtract") {
			const subPrim = subPrimById.get(edge.ownerId);
			const isInternalSub = subPrim ? subPrim.isInternalFeature !== false : true;
			const dAdd = evalAddOnlySDF(pt);
			// Rule 2.2 (1): Strictly clip subtract hole/slot lines to additive solid interior (dAdd <= -0.05)
			if (isInternalSub && dAdd > -0.05) return "air";
			if (!isPointOnRealCSGSurface(pt, edge.ownerType, edge.ownerId, baseExtrusions, bossSolids, subSolids, edge.secondOwnerId)) return "air";
			// Rule 2.2 (2): Lock internal hole/slot wall generators inside the additive solid to thin_dashed
			if (isInternalSub || dAdd < -0.15) return "thin_dashed";
		} else {
			// Rule 3.2: Suppress coplanar internal seam segments between multiple add primitives
			if (addListAll.length >= 2) {
				const touchingAddCount = addListAll.filter((p) => Math.abs(evalPrimitiveSDF(pt, p)) <= 0.15).length;
				if (touchingAddCount >= 2) {
					const eps = 0.25;
					const insideAlongX = evalCSGSDF({ x: pt.x - eps, y: pt.y, z: pt.z }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05 && evalCSGSDF({ x: pt.x + eps, y: pt.y, z: pt.z }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05;
					const insideAlongY = evalCSGSDF({ x: pt.x, y: pt.y - eps, z: pt.z }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05 && evalCSGSDF({ x: pt.x, y: pt.y + eps, z: pt.z }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05;
					const insideAlongZ = evalCSGSDF({ x: pt.x, y: pt.y, z: pt.z - eps }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05 && evalCSGSDF({ x: pt.x, y: pt.y, z: pt.z + eps }, baseExtrusions, bossSolids, subSolids).sdfCSG < -0.05;
					if (insideAlongX && insideAlongY && insideAlongZ) return "air";
				}
			}
			if (!isPointOnRealCSGSurface(pt, edge.ownerType, edge.ownerId, baseExtrusions, bossSolids, subSolids, edge.secondOwnerId)) return "air";
		}
		return isPointOccludedInView(pt, targetView, bounds, baseExtrusions, bossSolids, subSolids) ? "thin_dashed" : "thick_solid";
	};
	const allCSGPrimsForSplitting = [...baseExtrusions, ...bossSolids, ...subSolids];
	for (const edge of lines3D) {
		if (dist2D(projectPoint3DToView(edge.p1, targetView), projectPoint3DToView(edge.p2, targetView)) < .35) continue;
		const len3D = Math.hypot(edge.p2.x - edge.p1.x, edge.p2.y - edge.p1.y, edge.p2.z - edge.p1.z);
		const numSamples = Math.max(2, Math.ceil(len3D / COARSE_STEP));
		const tRaw: number[] = [];
		for (let i = 0; i <= numSamples; i++) tRaw.push(i / numSamples);
		const dx = edge.p2.x - edge.p1.x;
		const dy = edge.p2.y - edge.p1.y;
		const dz = edge.p2.z - edge.p1.z;
		const addT = (tVal: number) => {
			if (tVal > 0.002 && tVal < 0.998) {
				tRaw.push(Math.max(0.001, tVal - 0.0025));
				tRaw.push(Math.min(0.999, tVal + 0.0025));
			}
		};
		for (const prim of allCSGPrimsForSplitting) {
			if (Math.abs(dx) > 1e-4) {
				addT((prim.xMin - edge.p1.x) / dx);
				addT((prim.xMax - edge.p1.x) / dx);
			}
			if (Math.abs(dy) > 1e-4) {
				addT((prim.yMin - edge.p1.y) / dy);
				addT((prim.yMax - edge.p1.y) / dy);
			}
			if (Math.abs(dz) > 1e-4) {
				addT((prim.zMin - edge.p1.z) / dz);
				addT((prim.zMax - edge.p1.z) / dz);
			}
		}
		tRaw.sort((a, b) => a - b);
		const tSamples: number[] = [];
		for (const tVal of tRaw) {
			if (tSamples.length === 0 || tVal - tSamples[tSamples.length - 1] > 0.0008) tSamples.push(tVal);
		}
		let runType = "air";
		let runStartPt = evalEdgeExactPt(edge, 0);
		for (let i = 0; i < tSamples.length; i++) {
			const t = tSamples[i];
			const state = evalEdgeState(edge, t);
			if (i === 0) {
				runType = state;
				runStartPt = evalEdgeExactPt(edge, 0);
			} else if (state !== runType) {
				let lo = tSamples[i - 1];
				let hi = t;
				for (let iter = 0; iter < 6; iter++) {
					const mid = .5 * (lo + hi);
					if (evalEdgeState(edge, mid) === runType) lo = mid;
					else hi = mid;
				}
				const splitPt = evalEdgeExactPt(edge, .5 * (lo + hi));
				if (runType !== "air") raw2DLines.push({
					id: `raw-ln-${raw2DLines.length}`,
					view: targetView,
					type: "line",
					lineType: runType,
					p1: projectPoint3DToView(runStartPt, targetView),
					p2: projectPoint3DToView(splitPt, targetView),
					source: "derived",
					featureId: edge.featureId,
					featureLabel: edge.featureLabel
				});
				runType = state;
				runStartPt = splitPt;
			}
		}
		if (runType !== "air") {
			const endPt = evalEdgeExactPt(edge, 1);
			raw2DLines.push({
				id: `raw-ln-${raw2DLines.length}`,
				view: targetView,
				type: "line",
				lineType: runType,
				p1: projectPoint3DToView(runStartPt, targetView),
				p2: projectPoint3DToView(endPt, targetView),
				source: "derived",
				featureId: edge.featureId,
				featureLabel: edge.featureLabel
			});
		}
	}
	const clippedLines = clipAndMergeLinearSegments2D(raw2DLines, targetView);
	const spaceCurveEntities = [];
	const evalCurvePtState = (pt, curve) => {
		if (!isPointOnRealCSGSurface(pt, curve.ownerType, curve.ownerId, baseExtrusions, bossSolids, subSolids, curve.secondOwnerId)) return "air";
		return isPointOccludedInView(pt, targetView, bounds, baseExtrusions, bossSolids, subSolids) ? "thin_dashed" : "thick_solid";
	};
	for (const curve of curves3D) {
		let curRunType = "air";
		let curRunPts = [];
		const flushCurveRun = () => {
			if (curRunType !== "air" && curRunPts.length >= 2) {
				let len2D = 0;
				for (let i = 0; i < curRunPts.length - 1; i++) len2D += dist2D(curRunPts[i], curRunPts[i + 1]);
				if (len2D >= .8) spaceCurveEntities.push({
					id: `derived-${targetView}-crv-${spaceCurveEntities.length}`,
					view: targetView,
					type: "polygon",
					lineType: curRunType,
					points: curRunPts.map((p) => ({
						u: Number(p.u.toFixed(2)),
						v: Number(p.v.toFixed(2))
					})),
					closed: false,
					source: "derived",
					featureId: curve.featureId || "custom_main",
					featureLabel: curve.featureLabel
				});
			}
			curRunPts = [];
		};
		for (const sp of curve.samples) {
			const sNeg = evalCurvePtState(sp.pNeg, curve);
			const sPos = evalCurvePtState(sp.pPos, curve);
			const bestState = sNeg === "thick_solid" || sPos === "thick_solid" ? "thick_solid" : sNeg === "thin_dashed" || sPos === "thin_dashed" ? "thin_dashed" : "air";
			const pt2D = projectPoint3DToView(sNeg === bestState ? sp.pNeg : sp.pPos, targetView);
			if (bestState === "air") {
				flushCurveRun();
				curRunType = "air";
			} else if (bestState !== curRunType) {
				if (curRunPts.length > 0) {
					curRunPts.push(pt2D);
					flushCurveRun();
				}
				curRunType = bestState;
				curRunPts = [pt2D];
			} else if (curRunPts.length === 0 || dist2D(curRunPts[curRunPts.length - 1], pt2D) >= .15) curRunPts.push(pt2D);
		}
		flushCurveRun();
	}
	const N_ANG = 48;
	const circleGroups = [];
	for (const c3 of circles3D) {
		const c2 = projectPoint3DToView(c3.center, targetView);
		let grp = circleGroups.find((g) => dist2D(g.center2D, c2) <= .4 && Math.abs(g.radius - c3.radius) <= .4);
		if (!grp) {
			grp = {
				center2D: {
					u: Number(c2.u.toFixed(2)),
					v: Number(c2.v.toFixed(2))
				},
				radius: Number(c3.radius.toFixed(2)),
				featureId: c3.featureId,
				featureLabel: c3.featureLabel,
				bins: Array(N_ANG).fill("air"),
				evaluators: []
			};
			circleGroups.push(grp);
		}
		const evalC3AtTheta = (theta) => {
			const cosT = Math.cos(theta);
			const sinT = Math.sin(theta);
			const pt = c3.axis === "Z" ? {
				x: c3.center.x + c3.radius * cosT,
				y: c3.center.y + c3.radius * sinT,
				z: c3.center.z
			} : c3.axis === "Y" ? {
				x: c3.center.x + c3.radius * cosT,
				y: c3.center.y,
				z: c3.center.z + c3.radius * sinT
			} : {
				x: c3.center.x,
				y: c3.center.y + c3.radius * cosT,
				z: c3.center.z + c3.radius * sinT
			};
			if (!isPointOnRealCSGSurface(pt, c3.ownerType, c3.ownerId, baseExtrusions, bossSolids, subSolids)) return "air";
			return isPointOccludedInView(pt, targetView, bounds, baseExtrusions, bossSolids, subSolids) ? "thin_dashed" : "thick_solid";
		};
		grp.evaluators.push(evalC3AtTheta);
		for (let k = 0; k < N_ANG; k++) {
			if (grp.bins[k] === "thick_solid") continue;
			const state = evalC3AtTheta((k + .5) / N_ANG * Math.PI * 2);
			if (state !== "air" && (grp.bins[k] === "air" || grp.bins[k] === "thin_dashed" && state === "thick_solid")) grp.bins[k] = state;
		}
	}
	for (const cyl of [
		...baseExtrusions,
		...bossSolids,
		...subSolids
	]) {
		if (!cyl.shape.startsWith("cylinder_")) continue;
		const isZ = cyl.shape === "cylinder_z" && targetView === "top";
		const isY = cyl.shape === "cylinder_y" && targetView === "front";
		const isX = cyl.shape === "cylinder_x" && targetView === "left";
		if (!isZ && !isY && !isX) continue;
		const r = cyl.radius ?? .5 * (cyl.xMax - cyl.xMin);
		const cx = cyl.centerX ?? .5 * (cyl.xMin + cyl.xMax);
		const cy = cyl.centerY ?? .5 * (cyl.yMin + cyl.yMax);
		const cz = cyl.centerZ ?? .5 * (cyl.zMin + cyl.zMax);
		const c2 = isZ ? {
			u: cx,
			v: cy
		} : isY ? {
			u: cx,
			v: cz
		} : {
			u: cy,
			v: cz
		};
		let grp = circleGroups.find((g) => dist2D(g.center2D, c2) <= .4 && Math.abs(g.radius - r) <= .4);
		if (!grp) {
			grp = {
				center2D: {
					u: Number(c2.u.toFixed(2)),
					v: Number(c2.v.toFixed(2))
				},
				radius: Number(r.toFixed(2)),
				featureId: cyl.featureId,
				featureLabel: cyl.label,
				bins: Array(N_ANG).fill("air"),
				evaluators: []
			};
			circleGroups.push(grp);
		}
		const ownerType = cyl.operation === "subtract" ? "subtract" : "add";
		const ownerId = cyl.operation === "subtract" ? cyl.id : cyl.id.startsWith("boss-") ? cyl.id : "base_solid";
		const wMin = isZ ? cyl.zMin : isY ? cyl.yMin : cyl.xMin;
		const wMax = isZ ? cyl.zMax : isY ? cyl.yMax : cyl.xMax;
		const wSamples = [
			wMin + .25 * (wMax - wMin),
			.5 * (wMin + wMax),
			wMin + .75 * (wMax - wMin)
		];
		const evalBarrelAtTheta = (theta) => {
			const cosT = Math.cos(theta);
			const sinT = Math.sin(theta);
			let best = "air";
			for (const w of wSamples) {
				const pt = isZ ? {
					x: cx + r * cosT,
					y: cy + r * sinT,
					z: w
				} : isY ? {
					x: cx + r * cosT,
					y: w,
					z: cz + r * sinT
				} : {
					x: w,
					y: cy + r * cosT,
					z: cz + r * sinT
				};
				if (isPointOnRealCSGSurface(pt, ownerType, ownerId, baseExtrusions, bossSolids, subSolids)) {
					const frontW = targetView === "top" ? wMax - .2 : targetView === "front" ? wMin + .2 : wMin + .2;
					const state = isPointOccludedInView(isZ ? {
						x: pt.x,
						y: pt.y,
						z: frontW
					} : isY ? {
						x: pt.x,
						y: frontW,
						z: pt.z
					} : {
						x: frontW,
						y: pt.y,
						z: pt.z
					}, targetView, bounds, baseExtrusions, bossSolids, subSolids) ? "thin_dashed" : "thick_solid";
					if (state === "thick_solid") return "thick_solid";
					best = state;
				}
			}
			return best;
		};
		grp.evaluators.push(evalBarrelAtTheta);
		for (let k = 0; k < N_ANG; k++) {
			if (grp.bins[k] === "thick_solid") continue;
			const state = evalBarrelAtTheta((k + .5) / N_ANG * Math.PI * 2);
			if (state !== "air" && (grp.bins[k] === "air" || grp.bins[k] === "thin_dashed" && state === "thick_solid")) grp.bins[k] = state;
		}
	}
	const evalGroupAtTheta = (grp, theta) => {
		let best = "air";
		for (const fn of grp.evaluators) {
			const st = fn(theta);
			if (st === "thick_solid") return "thick_solid";
			if (st === "thin_dashed") best = "thin_dashed";
		}
		return best;
	};
	const circleAndArcEntities = [];
	for (const grp of circleGroups) {
		const allSolid = grp.bins.every((b) => b === "thick_solid");
		const allDashed = grp.bins.every((b) => b === "thin_dashed");
		if (allSolid || allDashed) {
			circleAndArcEntities.push({
				id: `derived-${targetView}-cir-${circleAndArcEntities.length}`,
				view: targetView,
				type: "circle",
				lineType: allSolid ? "thick_solid" : "thin_dashed",
				center: grp.center2D,
				radius: grp.radius,
				source: "derived",
				featureId: grp.featureId,
				featureLabel: grp.featureLabel
			});
			continue;
		}
		const spans = [];
		let curType = grp.bins[0];
		let curStart = 0;
		for (let k = 1; k < N_ANG; k++) if (grp.bins[k] !== curType) {
			if (curType !== "air") spans.push({
				startBin: curStart,
				endBin: k,
				type: curType
			});
			curType = grp.bins[k];
			curStart = k;
		}
		if (curType !== "air") spans.push({
			startBin: curStart,
			endBin: N_ANG,
			type: curType
		});
		if (spans.length >= 2 && spans[0].startBin === 0 && spans[spans.length - 1].endBin === N_ANG && spans[0].type === spans[spans.length - 1].type) {
			spans[0].startBin = spans[spans.length - 1].startBin - N_ANG;
			spans.pop();
		}
		for (const sp of spans) {
			const binCount = sp.endBin - sp.startBin;
			if (binCount >= 47) circleAndArcEntities.push({
				id: `derived-${targetView}-cir-${circleAndArcEntities.length}`,
				view: targetView,
				type: "circle",
				lineType: sp.type,
				center: grp.center2D,
				radius: grp.radius,
				source: "derived",
				featureId: grp.featureId,
				featureLabel: grp.featureLabel
			});
			else if (binCount >= 1) {
				let loStart = (sp.startBin - .5) / N_ANG * Math.PI * 2;
				let hiStart = (sp.startBin + .5) / N_ANG * Math.PI * 2;
				for (let iter = 0; iter < 5; iter++) {
					const mid = .5 * (loStart + hiStart);
					if (evalGroupAtTheta(grp, mid) === sp.type) hiStart = mid;
					else loStart = mid;
				}
				let loEnd = (sp.endBin - .5) / N_ANG * Math.PI * 2;
				let hiEnd = (sp.endBin + .5) / N_ANG * Math.PI * 2;
				for (let iter = 0; iter < 5; iter++) {
					const mid = .5 * (loEnd + hiEnd);
					if (evalGroupAtTheta(grp, mid) === sp.type) loEnd = mid;
					else hiEnd = mid;
				}
				const startAngle = normalizeAngle(.5 * (loStart + hiStart));
				const endAngle = normalizeAngle(.5 * (loEnd + hiEnd));
				circleAndArcEntities.push({
					id: `derived-${targetView}-arc-${circleAndArcEntities.length}`,
					view: targetView,
					type: "arc",
					lineType: sp.type,
					center: grp.center2D,
					radius: grp.radius,
					startAngle,
					endAngle,
					source: "derived",
					featureId: grp.featureId,
					featureLabel: grp.featureLabel
				});
			}
		}
	}
	const centerlines = [];
	const emittedAxes = /* @__PURE__ */ new Set();
	for (const cyl of [
		...baseExtrusions,
		...bossSolids,
		...subSolids
	]) {
		if (!(cyl.shape.startsWith("cylinder_") || cyl.shape.startsWith("cone_") || cyl.shape === "sphere" || cyl.shape === "hemisphere")) continue;
		const r = cyl.radius ?? cyl.rMin ?? .5 * (cyl.xMax - cyl.xMin);
		const cx = Number((cyl.centerX ?? .5 * (cyl.xMin + cyl.xMax)).toFixed(1));
		const cy = Number((cyl.centerY ?? .5 * (cyl.yMin + cyl.yMax)).toFixed(1));
		const cz = Number((cyl.centerZ ?? .5 * (cyl.zMin + cyl.zMax)).toFixed(1));
		if (cyl.operation === "subtract" && (cx < bounds.xMin - .5 || cx > bounds.xMax + .5 || cy < bounds.yMin - .5 || cy > bounds.yMax + .5 || cz < bounds.zMin - .5 || cz > bounds.zMax + .5)) continue;
		const cXMin = Math.max(bounds.xMin, cyl.xMin);
		const cXMax = Math.min(bounds.xMax, cyl.xMax);
		const cYMin = Math.max(bounds.yMin, cyl.yMin);
		const cYMax = Math.min(bounds.yMax, cyl.yMax);
		const cZMin = Math.max(bounds.zMin, cyl.zMin);
		const cZMax = Math.min(bounds.zMax, cyl.zMax);
		if (cyl.shape === "sphere" || cyl.shape === "hemisphere") {
			const uC = targetView === "left" ? cy : cx;
			const vC = targetView === "top" ? cy : cz;
			const uMinH = targetView === "left" ? cYMin : cXMin;
			const uMaxH = targetView === "left" ? cYMax : cXMax;
			const vMinH = targetView === "top" ? cYMin : cZMin;
			const vMaxH = targetView === "top" ? cYMax : cZMax;
			const key = `SPH-CROSS-${uC}-${vC}-${r}`;
			if (!emittedAxes.has(key)) {
				emittedAxes.add(key);
				const isHemiFlatHoriz = cyl.shape === "hemisphere" && (Math.abs(vC - vMinH) <= 3.5 || Math.abs(vC - vMaxH) <= 3.5) && (vMaxH - vMinH) < 1.6 * r;
				const isHemiFlatVert = cyl.shape === "hemisphere" && (Math.abs(uC - uMinH) <= 3.5 || Math.abs(uC - uMaxH) <= 3.5) && (uMaxH - uMinH) < 1.6 * r;
				if (!isHemiFlatHoriz) {
					centerlines.push({
						id: `derived-${targetView}-sch-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number(((isHemiFlatVert ? uMinH : uC - r) - 4).toFixed(1)),
							v: vC
						},
						p2: {
							u: Number(((isHemiFlatVert ? uMaxH : uC + r) + 4).toFixed(1)),
							v: vC
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
				if (!isHemiFlatVert) {
					centerlines.push({
						id: `derived-${targetView}-scv-${centerlines.length + 1}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: uC,
							v: Number(((isHemiFlatHoriz ? vMinH : vC - r) - 4).toFixed(1))
						},
						p2: {
							u: uC,
							v: Number(((isHemiFlatHoriz ? vMaxH : vC + r) + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			}
			continue;
		}
		if (cyl.shape === "cylinder_z" || cyl.shape === "cone_z") {
			if (targetView === "front" || targetView === "left") {
				const uAxis = targetView === "front" ? cx : cy;
				const key = `V-${uAxis}-${cZMin}-${cZMax}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-axis-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: uAxis,
							v: Number((cZMin - 4).toFixed(1))
						},
						p2: {
							u: uAxis,
							v: Number((cZMax + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			} else if (targetView === "top") {
				const key = `CROSS-${cx}-${cy}-${r}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-ch-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number((cx - r - 4).toFixed(1)),
							v: cy
						},
						p2: {
							u: Number((cx + r + 4).toFixed(1)),
							v: cy
						},
						source: "derived",
						featureId: cyl.featureId
					}, {
						id: `derived-${targetView}-cv-${centerlines.length + 1}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: cx,
							v: Number((cy - r - 4).toFixed(1))
						},
						p2: {
							u: cx,
							v: Number((cy + r + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			}
		} else if (cyl.shape === "cylinder_y" || cyl.shape === "cone_y") {
			if (targetView === "top") {
				const key = `V-${cx}-${cYMin}-${cYMax}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-axis-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: cx,
							v: Number((cYMin - 4).toFixed(1))
						},
						p2: {
							u: cx,
							v: Number((cYMax + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			} else if (targetView === "left") {
				const key = `H-${cz}-${cYMin}-${cYMax}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-axis-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number((cYMin - 4).toFixed(1)),
							v: cz
						},
						p2: {
							u: Number((cYMax + 4).toFixed(1)),
							v: cz
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			} else if (targetView === "front") {
				const key = `CROSS-${cx}-${cz}-${r}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-ch-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number((cx - r - 4).toFixed(1)),
							v: cz
						},
						p2: {
							u: Number((cx + r + 4).toFixed(1)),
							v: cz
						},
						source: "derived",
						featureId: cyl.featureId
					}, {
						id: `derived-${targetView}-cv-${centerlines.length + 1}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: cx,
							v: Number((cz - r - 4).toFixed(1))
						},
						p2: {
							u: cx,
							v: Number((cz + r + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			}
		} else if (cyl.shape === "cylinder_x" || cyl.shape === "cone_x") {
			if (targetView === "front" || targetView === "top") {
				const vAxis = targetView === "front" ? cz : cy;
				const key = `H-${vAxis}-${cXMin}-${cXMax}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-axis-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number((cXMin - 4).toFixed(1)),
							v: vAxis
						},
						p2: {
							u: Number((cXMax + 4).toFixed(1)),
							v: vAxis
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			} else if (targetView === "left") {
				const key = `CROSS-${cy}-${cz}-${r}`;
				if (!emittedAxes.has(key)) {
					emittedAxes.add(key);
					centerlines.push({
						id: `derived-${targetView}-ch-${centerlines.length}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: Number((cy - r - 4).toFixed(1)),
							v: cz
						},
						p2: {
							u: Number((cy + r + 4).toFixed(1)),
							v: cz
						},
						source: "derived",
						featureId: cyl.featureId
					}, {
						id: `derived-${targetView}-cv-${centerlines.length + 1}`,
						view: targetView,
						type: "line",
						lineType: "center_dot_dash",
						p1: {
							u: cy,
							v: Number((cz - r - 4).toFixed(1))
						},
						p2: {
							u: cy,
							v: Number((cz + r + 4).toFixed(1))
						},
						source: "derived",
						featureId: cyl.featureId
					});
				}
			}
		}
	}
	const filteredCenterlines = centerlines.filter((cl) => {
		if (cl.type !== "line") return true;
		const isHoriz = Math.abs(cl.p1.v - cl.p2.v) <= 0.2;
		const isVert = Math.abs(cl.p1.u - cl.p2.u) <= 0.2;
		for (const sl of clippedLines) {
			if (sl.type !== "line" || sl.lineType !== "thick_solid") continue;
			if (isHoriz && Math.abs(sl.p1.v - sl.p2.v) <= 0.2 && Math.abs(sl.p1.v - cl.p1.v) <= 0.8) {
				const sMin = Math.min(sl.p1.u, sl.p2.u);
				const sMax = Math.max(sl.p1.u, sl.p2.u);
				const cMin = Math.min(cl.p1.u, cl.p2.u);
				const cMax = Math.max(cl.p1.u, cl.p2.u);
				if (sMax - sMin >= (cMax - cMin) * 0.65) return false;
			}
			if (isVert && Math.abs(sl.p1.u - sl.p2.u) <= 0.2 && Math.abs(sl.p1.u - cl.p1.u) <= 0.8) {
				const sMin = Math.min(sl.p1.v, sl.p2.v);
				const sMax = Math.max(sl.p1.v, sl.p2.v);
				const cMin = Math.min(cl.p1.v, cl.p2.v);
				const cMax = Math.max(cl.p1.v, cl.p2.v);
				if (sMax - sMin >= (cMax - cMin) * 0.65) return false;
			}
		}
		return true;
	});
	return [
		...clippedLines,
		...spaceCurveEntities,
		...circleAndArcEntities,
		...filteredCenterlines
	];
}
