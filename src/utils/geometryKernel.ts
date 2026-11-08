/**
 * High-Level 2D Topology, Cross-View CSG Pairing, Derivation & Diagnostic Engine (geometryKernel.ts)
 */
import {
  polygonArea2D,
  pointInPolygon2D,
  curvedLoopSignedDist2D,
  evalPrimitiveSDF,
  evalCSGSDF,
  isPointOnRealCSGSurface,
  isPointOccludedInView,
  projectPoint3DToView,
  generateAllCandidate3DEdges,
  clipAndMergeLinearSegments2D,
  projectCSGSolidToView,
} from "./csgPrimitives";

export {
  polygonArea2D,
  pointInPolygon2D,
  curvedLoopSignedDist2D,
  evalPrimitiveSDF,
  evalCSGSDF,
  isPointOnRealCSGSurface,
  isPointOccludedInView,
  projectPoint3DToView,
  generateAllCandidate3DEdges,
  clipAndMergeLinearSegments2D,
  projectCSGSolidToView,
};

import {
  CadArcEntity,
  CadCircleEntity,
  CadEntity,
  CadLineEntity,
  CadPolygonEntity,
  DiagnosticIssue,
  GradingItem,
  GradingReport,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  Primitive3D,
  ProjectionStep,
  ReconstructedSolution,
  SnapResult,
  SnapType,
  ViewType,
} from "../types/cad";

export interface Segment2D {
  p1: Point2D;
  p2: Point2D;
  entityId: string;
  lineType: LineType;
  view: ViewType;
  featureId?: string;
}

// src/utils/geometryKernel.ts
export function dist2D(a, b) {
	return Math.hypot(a.u - b.u, a.v - b.v);
}
/**
* Normalize angle into [0, 2*PI)
*/
export function normalizeAngle(rad) {
	const twoPi = Math.PI * 2;
	return (rad % twoPi + twoPi) % twoPi;
}
/**
* Check if angle `a` lies counter-clockwise between `start` and `end`
*/
export function isAngleOnArc(a, start, end, tol = .001) {
	const na = normalizeAngle(a);
	const ns = normalizeAngle(start);
	const span = normalizeAngle(normalizeAngle(end) - ns);
	const rel = normalizeAngle(na - ns);
	return rel <= span + tol || rel >= Math.PI * 2 - tol;
}
/**
* Compute exact 2D bounding box of a circular arc strictly from its start point,
* end point, and standard quadrant angles {0, π/2, π, 3π/2} strictly inside [startAngle, endAngle].
* Never uses center ± radius or includes the circle center.
*/
export function getArcExactBounds(center, radius, startAngle, endAngle) {
	const pStart = {
		u: center.u + radius * Math.cos(startAngle),
		v: center.v + radius * Math.sin(startAngle)
	};
	const pEnd = {
		u: center.u + radius * Math.cos(endAngle),
		v: center.v + radius * Math.sin(endAngle)
	};
	let uMin = Math.min(pStart.u, pEnd.u);
	let uMax = Math.max(pStart.u, pEnd.u);
	let vMin = Math.min(pStart.v, pEnd.v);
	let vMax = Math.max(pStart.v, pEnd.v);
	const quadAngles = [
		0,
		Math.PI * .5,
		Math.PI,
		Math.PI * 1.5
	];
	for (const theta of quadAngles) if (isAngleOnArc(theta, startAngle, endAngle, -1e-4)) {
		const qu = center.u + radius * Math.cos(theta);
		const qv = center.v + radius * Math.sin(theta);
		uMin = Math.min(uMin, qu);
		uMax = Math.max(uMax, qu);
		vMin = Math.min(vMin, qv);
		vMax = Math.max(vMax, qv);
	}
	return {
		uMin,
		uMax,
		vMin,
		vMax
	};
}
/**
* Analytical intersection between a line segment (or infinite ray/line) and a circle
*/
export function intersectLineCircle(p1, p2, center, radius, mode = "segment") {
	const dx = p2.u - p1.u;
	const dy = p2.v - p1.v;
	const fx = p1.u - center.u;
	const fy = p1.v - center.v;
	const a = dx * dx + dy * dy;
	if (a < 1e-9) return [];
	const b = 2 * (fx * dx + fy * dy);
	const c = fx * fx + fy * fy - radius * radius;
	let disc = b * b - 4 * a * c;
	if (disc < -1e-5) return [];
	disc = Math.max(0, disc);
	const sqrtDisc = Math.sqrt(disc);
	const tCandidates = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
	const results = [];
	for (const t of tCandidates) if (mode === "infinite" || mode === "ray" && t >= -1e-4 || mode === "segment" && t >= -1e-4 && t <= 1.0001) {
		const u = Number((p1.u + t * dx).toFixed(2));
		const v = Number((p1.v + t * dy).toFixed(2));
		const angle = normalizeAngle(Math.atan2(v - center.v, u - center.u));
		if (!results.some((r) => Math.hypot(r.point.u - u, r.point.v - v) < .05)) results.push({
			point: {
				u,
				v
			},
			t,
			angle
		});
	}
	return results;
}
/**
* Analytical intersection between two circles
*/
export function intersectCircleCircle(c1, r1, c2, r2) {
	const d = dist2D(c1, c2);
	if (d > r1 + r2 + 1e-4 || d < Math.abs(r1 - r2) - 1e-4 || d < 1e-7) return [];
	const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
	const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
	const x2 = c1.u + a * (c2.u - c1.u) / d;
	const y2 = c1.v + a * (c2.v - c1.v) / d;
	const rx = -(c2.v - c1.v) * (h / d);
	const ry = (c2.u - c1.u) * (h / d);
	const pA = {
		u: Number((x2 + rx).toFixed(2)),
		v: Number((y2 + ry).toFixed(2))
	};
	const pB = {
		u: Number((x2 - rx).toFixed(2)),
		v: Number((y2 - ry).toFixed(2))
	};
	if (dist2D(pA, pB) < .05) return [pA];
	return [pA, pB];
}
/**
* Compute tangent point on a circle from an external point P (chosen closest to hintPt)
*/
export function computeCircleTangentPoint(externalPt, center, radius, hintPt) {
	const dx = externalPt.u - center.u;
	const dy = externalPt.v - center.v;
	const d = Math.hypot(dx, dy);
	if (d <= radius + .001) {
		const ang = Math.atan2(hintPt.v - center.v, hintPt.u - center.u);
		return {
			u: Number((center.u + Math.cos(ang) * radius).toFixed(2)),
			v: Number((center.v + Math.sin(ang) * radius).toFixed(2))
		};
	}
	const baseAngle = Math.atan2(dy, dx);
	const offsetAngle = Math.acos(Math.min(1, Math.max(-1, radius / d)));
	const a1 = baseAngle + offsetAngle;
	const a2 = baseAngle - offsetAngle;
	const t1 = {
		u: Number((center.u + Math.cos(a1) * radius).toFixed(2)),
		v: Number((center.v + Math.sin(a1) * radius).toFixed(2))
	};
	const t2 = {
		u: Number((center.u + Math.cos(a2) * radius).toFixed(2)),
		v: Number((center.v + Math.sin(a2) * radius).toFixed(2))
	};
	return dist2D(t1, hintPt) <= dist2D(t2, hintPt) ? t1 : t2;
}
/**
* Expand any CadEntity into straight segments
*/
export function expandEntityToSegments(ent, circleSegments = 32) {
	const res = [];
	if (ent.type === "line") res.push({
		p1: ent.p1,
		p2: ent.p2,
		entityId: ent.id,
		lineType: ent.lineType,
		view: ent.view,
		featureId: ent.featureId
	});
	else if (ent.type === "rect") {
		const pts = [
			{
				u: ent.x,
				v: ent.y
			},
			{
				u: ent.x + ent.width,
				v: ent.y
			},
			{
				u: ent.x + ent.width,
				v: ent.y + ent.height
			},
			{
				u: ent.x,
				v: ent.y + ent.height
			}
		];
		for (let i = 0; i < 4; i++) res.push({
			p1: pts[i],
			p2: pts[(i + 1) % 4],
			entityId: ent.id,
			lineType: ent.lineType,
			view: ent.view,
			featureId: ent.featureId
		});
	} else if (ent.type === "polygon") {
		const n = ent.points.length;
		for (let i = 0; i < (ent.closed ? n : n - 1); i++) res.push({
			p1: ent.points[i],
			p2: ent.points[(i + 1) % n],
			entityId: ent.id,
			lineType: ent.lineType,
			view: ent.view,
			featureId: ent.featureId
		});
	} else if (ent.type === "circle") for (let i = 0; i < circleSegments; i++) {
		const a1 = i / circleSegments * Math.PI * 2;
		const a2 = (i + 1) / circleSegments * Math.PI * 2;
		res.push({
			p1: {
				u: ent.center.u + Math.cos(a1) * ent.radius,
				v: ent.center.v + Math.sin(a1) * ent.radius
			},
			p2: {
				u: ent.center.u + Math.cos(a2) * ent.radius,
				v: ent.center.v + Math.sin(a2) * ent.radius
			},
			entityId: ent.id,
			lineType: ent.lineType,
			view: ent.view,
			featureId: ent.featureId
		});
	}
	else if (ent.type === "arc") {
		const span = normalizeAngle(ent.endAngle - ent.startAngle) || Math.PI * 2;
		const steps = Math.max(8, Math.round(span / (Math.PI * 2) * circleSegments));
		for (let i = 0; i < steps; i++) {
			const a1 = ent.startAngle + i / steps * span;
			const a2 = ent.startAngle + (i + 1) / steps * span;
			res.push({
				p1: {
					u: ent.center.u + Math.cos(a1) * ent.radius,
					v: ent.center.v + Math.sin(a1) * ent.radius
				},
				p2: {
					u: ent.center.u + Math.cos(a2) * ent.radius,
					v: ent.center.v + Math.sin(a2) * ent.radius
				},
				entityId: ent.id,
				lineType: ent.lineType,
				view: ent.view,
				featureId: ent.featureId
			});
		}
	}
	return res;
}
/**
* Segment-segment intersection in 2D
*/
export function intersectSegments(a1, a2, b1, b2, infinite = false) {
	const dax = a2.u - a1.u;
	const day = a2.v - a1.v;
	const dbx = b2.u - b1.u;
	const dby = b2.v - b1.v;
	const denom = dax * dby - day * dbx;
	if (Math.abs(denom) < 1e-7) return null;
	const t = ((b1.u - a1.u) * dby - (b1.v - a1.v) * dbx) / denom;
	const u = ((b1.u - a1.u) * day - (b1.v - a1.v) * dax) / denom;
	if (infinite || t >= -1e-4 && t <= 1.0001 && u >= -1e-4 && u <= 1.0001) return {
		u: Number((a1.u + t * dax).toFixed(2)),
		v: Number((a1.v + t * day).toFixed(2))
	};
	return null;
}
/**
* Distance from point to segment
*/
export function pointToSegmentDist(p, a, b) {
	const dx = b.u - a.u;
	const dy = b.v - a.v;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-8) return {
		dist: dist2D(p, a),
		proj: a,
		t: 0
	};
	const tRaw = ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq;
	const t = Math.max(0, Math.min(1, tRaw));
	const proj = {
		u: a.u + t * dx,
		v: a.v + t * dy
	};
	return {
		dist: dist2D(p, proj),
		proj,
		t
	};
}
/**
* Collect all exact intersections between `targetEnt` and all other entities in the same view
* (including infinite-line extensions hitting circles/arcs so approaching lines lock onto arc intersections)
*/
export function findIntersectionsWithEntity(targetEnt, otherEntities, allowLineExtensionOnCurve = false) {
	const pts = [];
	const pushUnique = (pt) => {
		if (!pts.some((p) => dist2D(p, pt) < .08)) pts.push(pt);
	};
	if (targetEnt.type === "circle" || targetEnt.type === "arc") for (const other of otherEntities) {
		if (other.id === targetEnt.id || other.view !== targetEnt.view) continue;
		if (other.type === "circle" || other.type === "arc") {
			const cPts = intersectCircleCircle(targetEnt.center, targetEnt.radius, other.center, other.radius);
			for (const cp of cPts) {
				const ang1 = normalizeAngle(Math.atan2(cp.v - targetEnt.center.v, cp.u - targetEnt.center.u));
				const ang2 = normalizeAngle(Math.atan2(cp.v - other.center.v, cp.u - other.center.u));
				const ok1 = targetEnt.type === "circle" || isAngleOnArc(ang1, targetEnt.startAngle, targetEnt.endAngle, .01);
				const ok2 = other.type === "circle" || isAngleOnArc(ang2, other.startAngle, other.endAngle, .01);
				if (ok1 && ok2) pushUnique(cp);
			}
		} else {
			const segs = expandEntityToSegments(other);
			const mode = allowLineExtensionOnCurve && other.type === "line" ? "infinite" : "segment";
			for (const s of segs) {
				const hits = intersectLineCircle(s.p1, s.p2, targetEnt.center, targetEnt.radius, mode);
				for (const h of hits) if (targetEnt.type === "circle" || isAngleOnArc(h.angle, targetEnt.startAngle, targetEnt.endAngle, .01)) pushUnique(h.point);
			}
		}
	}
	else {
		const targetSegs = expandEntityToSegments(targetEnt);
		const mode = allowLineExtensionOnCurve && targetEnt.type === "line" ? "infinite" : "segment";
		for (const ts of targetSegs) for (const other of otherEntities) {
			if (other.id === targetEnt.id || other.view !== targetEnt.view) continue;
			if (other.type === "circle" || other.type === "arc") {
				const hits = intersectLineCircle(ts.p1, ts.p2, other.center, other.radius, mode);
				for (const h of hits) if (other.type === "circle" || isAngleOnArc(h.angle, other.startAngle, other.endAngle, .01)) pushUnique(h.point);
			} else {
				const otherSegs = expandEntityToSegments(other);
				for (const os of otherSegs) {
					const pt = intersectSegments(ts.p1, ts.p2, os.p1, os.p2, false);
					if (pt) pushUnique(pt);
				}
			}
		}
	}
	return pts;
}
/**
* Compute OSNAP target in a given view (with exact analytical circle/arc/line intersections,
* active rubber-band line / ortho / cross-view alignment intersections with arcs/circles, & arc endpoints)
*/
export function computeOSnap(rawPt, view, entities, enabledSnaps, gridStep = 4, snapRadius = 3.6, excludeEntityIds, activeAnchorPt) {
	const viewEntities = entities.filter((e) => e.view === view && (!excludeEntityIds || !excludeEntityIds.has(e.id)));
	const candidates = [];
	const crossAlignTol = Math.min(snapRadius * .85, 2.8);
	const extractFeatureValues = (targetView) => {
		const uVals = [];
		const vVals = [];
		for (const ent of entities) {
			if (ent.view !== targetView || excludeEntityIds && excludeEntityIds.has(ent.id)) continue;
			if (ent.type === "circle" || ent.type === "arc") {
				uVals.push(ent.center.u, ent.center.u - ent.radius, ent.center.u + ent.radius);
				vVals.push(ent.center.v, ent.center.v - ent.radius, ent.center.v + ent.radius);
			} else {
				const segs = expandEntityToSegments(ent, 8);
				for (const s of segs) {
					uVals.push(s.p1.u, s.p2.u);
					vVals.push(s.p1.v, s.p2.v);
				}
			}
		}
		return {
			uVals,
			vVals
		};
	};
	let alignedU = null;
	let alignedV = null;
	let alignLabel = "";
	if (view === "front") {
		const { uVals: topX } = extractFeatureValues("top");
		const { vVals: leftZ } = extractFeatureValues("left");
		for (const x of topX) if (Math.abs(rawPt.u - x) <= crossAlignTol) {
			alignedU = x;
			alignLabel = "X-ALIGN";
			break;
		}
		for (const z of leftZ) if (Math.abs(rawPt.v - z) <= crossAlignTol) {
			alignedV = z;
			alignLabel = alignLabel ? "XZ-ALIGN" : "Z-ALIGN";
			break;
		}
	} else if (view === "top") {
		const { uVals: frontX } = extractFeatureValues("front");
		const { uVals: leftY } = extractFeatureValues("left");
		for (const x of frontX) if (Math.abs(rawPt.u - x) <= crossAlignTol) {
			alignedU = x;
			alignLabel = "X-ALIGN";
			break;
		}
		for (const y of leftY) if (Math.abs(rawPt.v - y) <= crossAlignTol) {
			alignedV = y;
			alignLabel = alignLabel ? "XY-ALIGN" : "Y-ALIGN";
			break;
		}
	} else if (view === "left") {
		const { vVals: topY } = extractFeatureValues("top");
		const { vVals: frontZ } = extractFeatureValues("front");
		for (const y of topY) if (Math.abs(rawPt.u - y) <= crossAlignTol) {
			alignedU = y;
			alignLabel = "Y-ALIGN";
			break;
		}
		for (const z of frontZ) if (Math.abs(rawPt.v - z) <= crossAlignTol) {
			alignedV = z;
			alignLabel = alignLabel ? "YZ-ALIGN" : "Z-ALIGN";
			break;
		}
	}
	const baseU = enabledSnaps.grid ? Math.round(rawPt.u / gridStep) * gridStep : Math.round(rawPt.u * 10) / 10;
	const baseV = enabledSnaps.grid ? Math.round(rawPt.v / gridStep) * gridStep : Math.round(rawPt.v * 10) / 10;
	for (const ent of viewEntities) if (ent.type === "circle" || ent.type === "arc") {
		if (enabledSnaps.center) {
			const d = dist2D(rawPt, ent.center);
			if (d <= snapRadius) candidates.push({
				point: ent.center,
				type: "center",
				label: "CEN",
				dist: d,
				priority: 1
			});
		}
		if (ent.type === "arc" && enabledSnaps.endpoint) {
			const ep1 = {
				u: Number((ent.center.u + Math.cos(ent.startAngle) * ent.radius).toFixed(2)),
				v: Number((ent.center.v + Math.sin(ent.startAngle) * ent.radius).toFixed(2))
			};
			const ep2 = {
				u: Number((ent.center.u + Math.cos(ent.endAngle) * ent.radius).toFixed(2)),
				v: Number((ent.center.v + Math.sin(ent.endAngle) * ent.radius).toFixed(2))
			};
			for (const ep of [ep1, ep2]) {
				const d = dist2D(rawPt, ep);
				if (d <= snapRadius) candidates.push({
					point: ep,
					type: "endpoint",
					label: "END",
					dist: d,
					priority: 1
				});
			}
		}
		if (enabledSnaps.quadrant) {
			const quadAngles = [
				0,
				Math.PI / 2,
				Math.PI,
				Math.PI * 3 / 2
			];
			for (const qa of quadAngles) {
				if (ent.type === "arc" && !isAngleOnArc(qa, ent.startAngle, ent.endAngle, .01)) continue;
				const q = {
					u: Number((ent.center.u + Math.cos(qa) * ent.radius).toFixed(2)),
					v: Number((ent.center.v + Math.sin(qa) * ent.radius).toFixed(2))
				};
				const d = dist2D(rawPt, q);
				if (d <= snapRadius) candidates.push({
					point: q,
					type: "quadrant",
					label: "QUA",
					dist: d,
					priority: 2
				});
			}
		}
	} else {
		const entSegs = expandEntityToSegments(ent, 16);
		for (const s of entSegs) {
			if (enabledSnaps.endpoint) for (const ep of [s.p1, s.p2]) {
				const d = dist2D(rawPt, ep);
				if (d <= snapRadius) candidates.push({
					point: ep,
					type: "endpoint",
					label: "END",
					dist: d,
					priority: 1
				});
			}
			if (enabledSnaps.midpoint) {
				const mid = {
					u: (s.p1.u + s.p2.u) / 2,
					v: (s.p1.v + s.p2.v) / 2
				};
				const d = dist2D(rawPt, mid);
				if (d <= snapRadius) candidates.push({
					point: mid,
					type: "midpoint",
					label: "MID",
					dist: d,
					priority: 2
				});
			}
		}
	}
	if (enabledSnaps.intersection) {
		if (viewEntities.length > 1) for (let i = 0; i < viewEntities.length; i++) {
			const hits = findIntersectionsWithEntity(viewEntities[i], viewEntities.slice(i + 1), true);
			for (const pt of hits) {
				const d = dist2D(rawPt, pt);
				if (d <= snapRadius) candidates.push({
					point: pt,
					type: "intersection",
					label: "INT",
					dist: d,
					priority: 1
				});
			}
		}
		const testLines = [];
		if (activeAnchorPt && dist2D(activeAnchorPt, rawPt) > .25) {
			testLines.push({
				p1: activeAnchorPt,
				p2: rawPt,
				mode: "ray",
				priority: 1
			});
			testLines.push({
				p1: activeAnchorPt,
				p2: {
					u: activeAnchorPt.u + 10,
					v: activeAnchorPt.v
				},
				mode: "infinite",
				priority: 1
			});
			testLines.push({
				p1: activeAnchorPt,
				p2: {
					u: activeAnchorPt.u,
					v: activeAnchorPt.v + 10
				},
				mode: "infinite",
				priority: 1
			});
			testLines.push({
				p1: activeAnchorPt,
				p2: {
					u: activeAnchorPt.u + 10,
					v: activeAnchorPt.v + 10
				},
				mode: "infinite",
				priority: 1
			});
			testLines.push({
				p1: activeAnchorPt,
				p2: {
					u: activeAnchorPt.u + 10,
					v: activeAnchorPt.v - 10
				},
				mode: "infinite",
				priority: 1
			});
		}
		if (alignedU !== null) testLines.push({
			p1: {
				u: alignedU,
				v: 0
			},
			p2: {
				u: alignedU,
				v: 100
			},
			mode: "infinite",
			priority: 1
		});
		if (alignedV !== null) testLines.push({
			p1: {
				u: 0,
				v: alignedV
			},
			p2: {
				u: 100,
				v: alignedV
			},
			mode: "infinite",
			priority: 1
		});
		if (enabledSnaps.grid) {
			testLines.push({
				p1: {
					u: baseU,
					v: 0
				},
				p2: {
					u: baseU,
					v: 100
				},
				mode: "infinite",
				priority: 2
			});
			testLines.push({
				p1: {
					u: 0,
					v: baseV
				},
				p2: {
					u: 100,
					v: baseV
				},
				mode: "infinite",
				priority: 2
			});
		}
		for (const ent of viewEntities) if (ent.type === "circle" || ent.type === "arc") {
			for (const tl of testLines) {
				const hits = intersectLineCircle(tl.p1, tl.p2, ent.center, ent.radius, tl.mode);
				for (const h of hits) {
					if (!(ent.type === "circle" || isAngleOnArc(h.angle, ent.startAngle, ent.endAngle, .01))) continue;
					const d = dist2D(rawPt, h.point);
					if (d <= snapRadius) candidates.push({
						point: h.point,
						type: "intersection",
						label: "INT",
						dist: d,
						priority: tl.priority
					});
				}
			}
			const dToRing = Math.abs(dist2D(rawPt, ent.center) - ent.radius);
			if (dToRing <= snapRadius * .85) {
				const ang = normalizeAngle(Math.atan2(rawPt.v - ent.center.v, rawPt.u - ent.center.u));
				if (ent.type === "circle" || isAngleOnArc(ang, ent.startAngle, ent.endAngle, .01)) {
					const onRingPt = {
						u: Number((ent.center.u + Math.cos(ang) * ent.radius).toFixed(2)),
						v: Number((ent.center.v + Math.sin(ang) * ent.radius).toFixed(2))
					};
					candidates.push({
						point: onRingPt,
						type: "intersection",
						label: "INT",
						dist: dToRing,
						priority: 3
					});
				}
			}
		} else if (activeAnchorPt && dist2D(activeAnchorPt, rawPt) > .25) {
			const entSegs = expandEntityToSegments(ent, 16);
			for (const s of entSegs) for (const orthoTarget of [{
				u: activeAnchorPt.u,
				v: rawPt.v
			}, {
				u: rawPt.u,
				v: activeAnchorPt.v
			}]) {
				if (dist2D(activeAnchorPt, orthoTarget) < .25) continue;
				const hit = intersectSegments(activeAnchorPt, orthoTarget, s.p1, s.p2, false);
				if (hit) {
					const d = dist2D(rawPt, hit);
					if (d <= snapRadius) candidates.push({
						point: hit,
						type: "intersection",
						label: "INT",
						dist: d,
						priority: 1
					});
				}
			}
		}
	}
	if (candidates.length > 0) {
		candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
		return {
			point: {
				u: Number(candidates[0].point.u.toFixed(2)),
				v: Number(candidates[0].point.v.toFixed(2))
			},
			type: candidates[0].type,
			label: candidates[0].label
		};
	}
	if (alignedU !== null || alignedV !== null) return {
		point: {
			u: Number((alignedU !== null ? alignedU : baseU).toFixed(2)),
			v: Number((alignedV !== null ? alignedV : baseV).toFixed(2))
		},
		type: "grid",
		label: alignLabel
	};
	if (enabledSnaps.grid) return {
		point: {
			u: baseU,
			v: baseV
		},
		type: "grid",
		label: "GRID"
	};
	return {
		point: {
			u: baseU,
			v: baseV
		},
		type: "grid",
		label: ""
	};
}
/**
* Find entity closest to cursor point in a view (accurately supporting Circle, Arc angular span, Line, Rect, Polygon)
*/
export function findHoveredEntity(pt, view, entities, tolerance = 3.5) {
	let best = null;
	for (const ent of entities) {
		if (ent.view !== view) continue;
		if (ent.type === "circle") {
			const dRing = Math.abs(dist2D(pt, ent.center) - ent.radius);
			const dCenter = dist2D(pt, ent.center);
			const d = Math.min(dRing, dCenter <= tolerance * .8 ? dCenter : dRing);
			if (d <= tolerance && (!best || d < best.d)) best = {
				ent,
				d
			};
		} else if (ent.type === "arc") {
			if (isAngleOnArc(normalizeAngle(Math.atan2(pt.v - ent.center.v, pt.u - ent.center.u)), ent.startAngle, ent.endAngle, .08)) {
				const d = Math.abs(dist2D(pt, ent.center) - ent.radius);
				if (d <= tolerance && (!best || d < best.d)) best = {
					ent,
					d
				};
			}
		} else {
			const segs = expandEntityToSegments(ent);
			for (const s of segs) {
				const { dist } = pointToSegmentDist(pt, s.p1, s.p2);
				if (dist <= tolerance && (!best || dist < best.d)) best = {
					ent,
					d: dist
				};
			}
		}
	}
	return best ? best.ent : null;
}
/**
* Extract interactive control grips for a selected entity
*/
export function getEntityGrips(ent) {
	if (ent.type === "line") return [
		{
			id: "p1",
			entityId: ent.id,
			point: ent.p1,
			kind: "endpoint"
		},
		{
			id: "p2",
			entityId: ent.id,
			point: ent.p2,
			kind: "endpoint"
		},
		{
			id: "mid",
			entityId: ent.id,
			point: {
				u: (ent.p1.u + ent.p2.u) / 2,
				v: (ent.p1.v + ent.p2.v) / 2
			},
			kind: "center"
		}
	];
	if (ent.type === "rect") {
		const x1 = ent.x;
		const y1 = ent.y;
		const x2 = ent.x + ent.width;
		const y2 = ent.y + ent.height;
		return [
			{
				id: "sw",
				entityId: ent.id,
				point: {
					u: x1,
					v: y1
				},
				kind: "corner"
			},
			{
				id: "se",
				entityId: ent.id,
				point: {
					u: x2,
					v: y1
				},
				kind: "corner"
			},
			{
				id: "ne",
				entityId: ent.id,
				point: {
					u: x2,
					v: y2
				},
				kind: "corner"
			},
			{
				id: "nw",
				entityId: ent.id,
				point: {
					u: x1,
					v: y2
				},
				kind: "corner"
			},
			{
				id: "center",
				entityId: ent.id,
				point: {
					u: (x1 + x2) / 2,
					v: (y1 + y2) / 2
				},
				kind: "center"
			}
		];
	}
	if (ent.type === "circle") return [
		{
			id: "center",
			entityId: ent.id,
			point: ent.center,
			kind: "center"
		},
		{
			id: "q0",
			entityId: ent.id,
			point: {
				u: ent.center.u + ent.radius,
				v: ent.center.v
			},
			kind: "radius"
		},
		{
			id: "q90",
			entityId: ent.id,
			point: {
				u: ent.center.u,
				v: ent.center.v + ent.radius
			},
			kind: "radius"
		},
		{
			id: "q180",
			entityId: ent.id,
			point: {
				u: ent.center.u - ent.radius,
				v: ent.center.v
			},
			kind: "radius"
		},
		{
			id: "q270",
			entityId: ent.id,
			point: {
				u: ent.center.u,
				v: ent.center.v - ent.radius
			},
			kind: "radius"
		}
	];
	if (ent.type === "arc") {
		const span = normalizeAngle(ent.endAngle - ent.startAngle) || Math.PI;
		const midAng = ent.startAngle + span / 2;
		return [
			{
				id: "center",
				entityId: ent.id,
				point: ent.center,
				kind: "center"
			},
			{
				id: "start",
				entityId: ent.id,
				point: {
					u: Number((ent.center.u + Math.cos(ent.startAngle) * ent.radius).toFixed(2)),
					v: Number((ent.center.v + Math.sin(ent.startAngle) * ent.radius).toFixed(2))
				},
				kind: "endpoint"
			},
			{
				id: "end",
				entityId: ent.id,
				point: {
					u: Number((ent.center.u + Math.cos(ent.endAngle) * ent.radius).toFixed(2)),
					v: Number((ent.center.v + Math.sin(ent.endAngle) * ent.radius).toFixed(2))
				},
				kind: "endpoint"
			},
			{
				id: "midRadius",
				entityId: ent.id,
				point: {
					u: Number((ent.center.u + Math.cos(midAng) * ent.radius).toFixed(2)),
					v: Number((ent.center.v + Math.sin(midAng) * ent.radius).toFixed(2))
				},
				kind: "radius"
			}
		];
	}
	if (ent.type === "polygon") {
		const n = ent.points.length || 1;
		const cu = ent.points.reduce((acc, p) => acc + p.u, 0) / n;
		const cv = ent.points.reduce((acc, p) => acc + p.v, 0) / n;
		return [{
			id: "center",
			entityId: ent.id,
			point: {
				u: cu,
				v: cv
			},
			kind: "center"
		}, ...ent.points.map((pt, idx) => ({
			id: `v_${idx}`,
			entityId: ent.id,
			point: pt,
			kind: "vertex"
		}))];
	}
	return [];
}
/**
* Translate a single CadEntity by (du, dv)
*/
export function translateEntity(ent, du, dv) {
	const r = (n) => Number(n.toFixed(1));
	if (ent.type === "line") return {
		...ent,
		p1: {
			u: r(ent.p1.u + du),
			v: r(ent.p1.v + dv)
		},
		p2: {
			u: r(ent.p2.u + du),
			v: r(ent.p2.v + dv)
		}
	};
	if (ent.type === "rect") return {
		...ent,
		x: r(ent.x + du),
		y: r(ent.y + dv)
	};
	if (ent.type === "circle" || ent.type === "arc") return {
		...ent,
		center: {
			u: r(ent.center.u + du),
			v: r(ent.center.v + dv)
		}
	};
	if (ent.type === "polygon") return {
		...ent,
		points: ent.points.map((pt) => ({
			u: r(pt.u + du),
			v: r(pt.v + dv)
		}))
	};
	return ent;
}
/**
* Resize or stretch a CadEntity by dragging one of its GripHandles to `newPt`
*/
export function applyGripDrag(ent, gripId, newPt) {
	const r = (n) => Number(n.toFixed(2));
	if (ent.type === "line") {
		if (gripId === "p1") return {
			...ent,
			p1: {
				u: r(newPt.u),
				v: r(newPt.v)
			}
		};
		if (gripId === "p2") return {
			...ent,
			p2: {
				u: r(newPt.u),
				v: r(newPt.v)
			}
		};
		if (gripId === "mid") {
			const midU = (ent.p1.u + ent.p2.u) / 2;
			const midV = (ent.p1.v + ent.p2.v) / 2;
			return translateEntity(ent, newPt.u - midU, newPt.v - midV);
		}
	}
	if (ent.type === "rect") {
		const x1 = ent.x;
		const y1 = ent.y;
		const x2 = ent.x + ent.width;
		const y2 = ent.y + ent.height;
		if (gripId === "center") {
			const cu = (x1 + x2) / 2;
			const cv = (y1 + y2) / 2;
			return translateEntity(ent, newPt.u - cu, newPt.v - cv);
		}
		let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;
		if (gripId === "sw") {
			nx1 = newPt.u;
			ny1 = newPt.v;
		} else if (gripId === "se") {
			nx2 = newPt.u;
			ny1 = newPt.v;
		} else if (gripId === "ne") {
			nx2 = newPt.u;
			ny2 = newPt.v;
		} else if (gripId === "nw") {
			nx1 = newPt.u;
			ny2 = newPt.v;
		}
		const rx = Math.min(nx1, nx2);
		const ry = Math.min(ny1, ny2);
		const rw = Math.max(2, Math.abs(nx2 - nx1));
		const rh = Math.max(2, Math.abs(ny2 - ny1));
		return {
			...ent,
			x: r(rx),
			y: r(ry),
			width: r(rw),
			height: r(rh)
		};
	}
	if (ent.type === "circle") {
		if (gripId === "center") return {
			...ent,
			center: {
				u: r(newPt.u),
				v: r(newPt.v)
			}
		};
		const newRadius = Math.max(1.5, r(dist2D(ent.center, newPt)));
		return {
			...ent,
			radius: newRadius
		};
	}
	if (ent.type === "arc") {
		if (gripId === "center") return {
			...ent,
			center: {
				u: r(newPt.u),
				v: r(newPt.v)
			}
		};
		if (gripId === "start") {
			const ang = normalizeAngle(Math.atan2(newPt.v - ent.center.v, newPt.u - ent.center.u));
			return {
				...ent,
				startAngle: ang
			};
		}
		if (gripId === "end") {
			const ang = normalizeAngle(Math.atan2(newPt.v - ent.center.v, newPt.u - ent.center.u));
			return {
				...ent,
				endAngle: ang
			};
		}
		if (gripId === "midRadius") {
			const newRadius = Math.max(1.5, r(dist2D(ent.center, newPt)));
			return {
				...ent,
				radius: newRadius
			};
		}
	}
	if (ent.type === "polygon") {
		const n = ent.points.length || 1;
		const cu = ent.points.reduce((acc, p) => acc + p.u, 0) / n;
		const cv = ent.points.reduce((acc, p) => acc + p.v, 0) / n;
		if (gripId === "center") return translateEntity(ent, newPt.u - cu, newPt.v - cv);
		if (gripId.startsWith("v_")) {
			const idx = Number(gripId.slice(2));
			const oldPt = ent.points[idx];
			if (!oldPt) return ent;
			const oldR = Math.hypot(oldPt.u - cu, oldPt.v - cv) || 1;
			const newR = Math.max(2, Math.hypot(newPt.u - cu, newPt.v - cv));
			const dAng = Math.atan2(newPt.v - cv, newPt.u - cu) - Math.atan2(oldPt.v - cv, oldPt.u - cu);
			const scale = newR / oldR;
			return {
				...ent,
				points: ent.points.map((pt) => {
					const pr = Math.hypot(pt.u - cu, pt.v - cv) * scale;
					const pang = Math.atan2(pt.v - cv, pt.u - cu) + dAng;
					return {
						u: r(cu + Math.cos(pang) * pr),
						v: r(cv + Math.sin(pang) * pr)
					};
				})
			};
		}
	}
	return ent;
}
/**
* CAD Box Selection:
* - isCrossing = false (Left-to-Right Window Selection): entity must lie 100% inside box
* - isCrossing = true  (Right-to-Left Crossing Selection): entity is inside OR intersects box boundary
*/
export function getEntitiesInSelectionBox(pStart, pEnd, view, entities, isCrossing) {
	const uMin = Math.min(pStart.u, pEnd.u);
	const uMax = Math.max(pStart.u, pEnd.u);
	const vMin = Math.min(pStart.v, pEnd.v);
	const vMax = Math.max(pStart.v, pEnd.v);
	const inBox = (pt) => pt.u >= uMin - .001 && pt.u <= uMax + .001 && pt.v >= vMin - .001 && pt.v <= vMax + .001;
	const boxEdges = [
		[{
			u: uMin,
			v: vMin
		}, {
			u: uMax,
			v: vMin
		}],
		[{
			u: uMax,
			v: vMin
		}, {
			u: uMax,
			v: vMax
		}],
		[{
			u: uMax,
			v: vMax
		}, {
			u: uMin,
			v: vMax
		}],
		[{
			u: uMin,
			v: vMax
		}, {
			u: uMin,
			v: vMin
		}]
	];
	const selectedIds = [];
	for (const ent of entities) {
		if (ent.view !== view) continue;
		const segs = expandEntityToSegments(ent, 32);
		if (segs.length === 0) continue;
		const allPointsInside = segs.every((s) => inBox(s.p1) && inBox(s.p2));
		if (!isCrossing) {
			if (allPointsInside) selectedIds.push(ent.id);
		} else {
			if (allPointsInside || segs.some((s) => inBox(s.p1) || inBox(s.p2))) {
				selectedIds.push(ent.id);
				continue;
			}
			let hitsEdge = false;
			for (const s of segs) {
				for (const [b1, b2] of boxEdges) if (intersectSegments(s.p1, s.p2, b1, b2, false)) {
					hitsEdge = true;
					break;
				}
				if (hitsEdge) break;
			}
			if (hitsEdge) selectedIds.push(ent.id);
		}
	}
	return selectedIds;
}
/**
* CAD Trim Tool:
* - Supports trimming Circles into Arcs at intersection points!
* - Supports trimming Arcs at intersection points!
* - Supports trimming Lines/Rects/Polygons against both Lines AND Circles/Arcs!
*/
export function trimEntityAtPoint(clickPt, view, entities) {
	const target = findHoveredEntity(clickPt, view, entities, 4.2);
	if (!target) return entities;
	const otherEntities = entities.filter((e) => e.id !== target.id && e.view === view);
	if (target.type === "circle") {
		const hitPts = findIntersectionsWithEntity(target, otherEntities);
		if (hitPts.length < 2) return entities.filter((e) => e.id !== target.id);
		const angles = hitPts.map((p) => normalizeAngle(Math.atan2(p.v - target.center.v, p.u - target.center.u))).sort((a, b) => a - b);
		const clickAngle = normalizeAngle(Math.atan2(clickPt.v - target.center.v, clickPt.u - target.center.u));
		const n = angles.length;
		let trimIdx = 0;
		for (let i = 0; i < n; i++) {
			const aStart = angles[i];
			const aEnd = angles[(i + 1) % n];
			if (isAngleOnArc(clickAngle, aStart, aEnd, 1e-4)) {
				trimIdx = i;
				break;
			}
		}
		const newStart = angles[(trimIdx + 1) % n];
		const newEnd = angles[trimIdx];
		const newArc = {
			id: `${target.id}-arc-${Date.now()}`,
			view: target.view,
			type: "arc",
			lineType: target.lineType,
			center: target.center,
			radius: target.radius,
			startAngle: newStart,
			endAngle: newEnd,
			source: "user",
			featureId: target.featureId,
			featureLabel: target.featureLabel
		};
		return entities.map((e) => e.id === target.id ? newArc : e);
	}
	if (target.type === "arc") {
		const hitPts = findIntersectionsWithEntity(target, otherEntities);
		if (hitPts.length === 0) return entities.filter((e) => e.id !== target.id);
		const span = normalizeAngle(target.endAngle - target.startAngle);
		const relAngles = [0, span];
		for (const p of hitPts) {
			const rel = normalizeAngle(normalizeAngle(Math.atan2(p.v - target.center.v, p.u - target.center.v)) - target.startAngle);
			if (rel > .02 && rel < span - .02) relAngles.push(rel);
		}
		relAngles.sort((a, b) => a - b);
		const clickRel = normalizeAngle(normalizeAngle(Math.atan2(clickPt.v - target.center.v, clickPt.u - target.center.u)) - target.startAngle);
		const keptArcs = [];
		for (let i = 0; i < relAngles.length - 1; i++) {
			const r0 = relAngles[i];
			const r1 = relAngles[i + 1];
			if (clickRel >= r0 - .001 && clickRel <= r1 + .001) continue;
			keptArcs.push({
				...target,
				id: `${target.id}-sub-${i}-${Date.now()}`,
				startAngle: normalizeAngle(target.startAngle + r0),
				endAngle: normalizeAngle(target.startAngle + r1)
			});
		}
		return [...entities.filter((e) => e.id !== target.id), ...keptArcs];
	}
	const workingList = [];
	let targetLines = [];
	for (const e of entities) if (e.id === target.id && (e.type === "line" || e.type === "rect" || e.type === "polygon")) targetLines = expandEntityToSegments(e).map((s, idx) => ({
		id: `${e.id}-seg-${idx}-${Date.now()}`,
		view: e.view,
		type: "line",
		lineType: e.lineType,
		p1: s.p1,
		p2: s.p2,
		source: "user",
		featureId: e.featureId,
		featureLabel: e.featureLabel
	}));
	else workingList.push(e);
	if (targetLines.length === 0) return entities;
	let clickedSegIdx = 0;
	let minD = Infinity;
	let clickT = .5;
	targetLines.forEach((ln, idx) => {
		const { dist, t } = pointToSegmentDist(clickPt, ln.p1, ln.p2);
		if (dist < minD) {
			minD = dist;
			clickedSegIdx = idx;
			clickT = t;
		}
	});
	const segToTrim = targetLines[clickedSegIdx];
	const dx = segToTrim.p2.u - segToTrim.p1.u;
	const dy = segToTrim.p2.v - segToTrim.p1.v;
	const lenSq = dx * dx + dy * dy;
	const hitPts = findIntersectionsWithEntity(segToTrim, [...workingList.filter((e) => e.view === view), ...targetLines.filter((_, idx) => idx !== clickedSegIdx)]);
	const ts = [0, 1];
	for (const pt of hitPts) if (lenSq > 1e-6) {
		const t = ((pt.u - segToTrim.p1.u) * dx + (pt.v - segToTrim.p1.v) * dy) / lenSq;
		if (t > .02 && t < .98) ts.push(t);
	}
	ts.sort((a, b) => a - b);
	const keptLines = [];
	for (let i = 0; i < ts.length - 1; i++) {
		const t0 = ts[i];
		const t1 = ts[i + 1];
		if (clickT >= t0 - 1e-4 && clickT <= t1 + 1e-4 && ts.length > 2) continue;
		if (ts.length === 2) continue;
		keptLines.push({
			...segToTrim,
			id: `${segToTrim.id}-p${i}`,
			p1: {
				u: Number((segToTrim.p1.u + t0 * dx).toFixed(2)),
				v: Number((segToTrim.p1.v + t0 * dy).toFixed(2))
			},
			p2: {
				u: Number((segToTrim.p1.u + t1 * dx).toFixed(2)),
				v: Number((segToTrim.p1.v + t1 * dy).toFixed(2))
			}
		});
	}
	return [
		...workingList,
		...targetLines.filter((_, idx) => idx !== clickedSegIdx),
		...keptLines
	];
}
/**
* CAD Extend Tool:
* - Extends Lines to nearest intersecting Line, Rect, Polygon, Circle, or Arc!
* - Extends Arcs to nearest intersection or closes an Arc back into a full Circle!
*/
export function extendEntityAtPoint(clickPt, view, entities) {
	const target = findHoveredEntity(clickPt, view, entities, 4.5);
	if (!target) return entities;
	if (target.type === "arc") {
		const closedCircle = {
			id: `${target.id}-circle-${Date.now()}`,
			view: target.view,
			type: "circle",
			lineType: target.lineType,
			center: target.center,
			radius: target.radius,
			source: "user",
			featureId: target.featureId,
			featureLabel: target.featureLabel
		};
		return entities.map((e) => e.id === target.id ? closedCircle : e);
	}
	if (target.type !== "line") return entities;
	const { t } = pointToSegmentDist(clickPt, target.p1, target.p2);
	const extendEnd2 = t >= .5;
	const startPt = extendEnd2 ? target.p1 : target.p2;
	const movingPt = extendEnd2 ? target.p2 : target.p1;
	const dirU = movingPt.u - startPt.u;
	const dirV = movingPt.v - startPt.v;
	const len = Math.hypot(dirU, dirV);
	if (len < 1e-5) return entities;
	const farPt = {
		u: movingPt.u + dirU / len * 240,
		v: movingPt.v + dirV / len * 240
	};
	let bestNewPt = null;
	let bestDist = Infinity;
	for (const e of entities) {
		if (e.view !== view || e.id === target.id) continue;
		if (e.type === "circle" || e.type === "arc") {
			const hits = intersectLineCircle(movingPt, farPt, e.center, e.radius, "segment");
			for (const h of hits) {
				if (e.type === "arc" && !isAngleOnArc(h.angle, e.startAngle, e.endAngle)) continue;
				const d = dist2D(movingPt, h.point);
				if (d > .5 && d < bestDist) {
					bestDist = d;
					bestNewPt = h.point;
				}
			}
		} else {
			const segs = expandEntityToSegments(e);
			for (const s of segs) {
				const hit = intersectSegments(movingPt, farPt, s.p1, s.p2, false);
				if (hit) {
					const d = dist2D(movingPt, hit);
					if (d > .5 && d < bestDist) {
						bestDist = d;
						bestNewPt = hit;
					}
				}
			}
		}
	}
	if (!bestNewPt) bestNewPt = {
		u: Number((movingPt.u + dirU / len * 16).toFixed(1)),
		v: Number((movingPt.v + dirV / len * 16).toFixed(1))
	};
	return entities.map((e) => {
		if (e.id !== target.id || e.type !== "line") return e;
		return extendEnd2 ? {
			...e,
			p2: bestNewPt
		} : {
			...e,
			p1: bestNewPt
		};
	});
}
/**
* CAD Offset Tool: Offset Line, Rect, Circle, Arc, or Polygon by offsetDist
*/
export function offsetEntityAtPoint(clickPt, view, entities, offsetDist = 8) {
	const target = findHoveredEntity(clickPt, view, entities, 5);
	if (!target) return entities;
	const newId = `offset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	if (target.type === "circle" || target.type === "arc") {
		const sign = dist2D(clickPt, target.center) >= target.radius ? 1 : -1;
		const newR = Number(Math.max(2, target.radius + sign * offsetDist).toFixed(1));
		return [...entities, {
			...target,
			id: newId,
			radius: newR,
			source: "user"
		}];
	}
	if (target.type === "rect") {
		const cx = target.x + target.width / 2;
		const cy = target.y + target.height / 2;
		const delta = clickPt.u > target.x && clickPt.u < target.x + target.width && clickPt.v > target.y && clickPt.v < target.y + target.height ? -offsetDist : offsetDist;
		const nw = Math.max(4, target.width + delta * 2);
		const nh = Math.max(4, target.height + delta * 2);
		return [...entities, {
			...target,
			id: newId,
			x: Number((cx - nw / 2).toFixed(1)),
			y: Number((cy - nh / 2).toFixed(1)),
			width: Number(nw.toFixed(1)),
			height: Number(nh.toFixed(1)),
			source: "user"
		}];
	}
	if (target.type === "line") {
		const dx = target.p2.u - target.p1.u;
		const dy = target.p2.v - target.p1.v;
		const len = Math.hypot(dx, dy) || 1;
		const nx = -dy / len;
		const ny = dx / len;
		const side = (clickPt.u - target.p1.u) * nx + (clickPt.v - target.p1.v) * ny >= 0 ? 1 : -1;
		const ou = nx * offsetDist * side;
		const ov = ny * offsetDist * side;
		return [...entities, {
			...target,
			id: newId,
			p1: {
				u: Number((target.p1.u + ou).toFixed(1)),
				v: Number((target.p1.v + ov).toFixed(1))
			},
			p2: {
				u: Number((target.p2.u + ou).toFixed(1)),
				v: Number((target.p2.v + ov).toFixed(1))
			},
			source: "user"
		}];
	}
	if (target.type === "polygon") {
		const n = target.points.length;
		if (n < 3) return entities;
		const cx = target.points.reduce((acc, p) => acc + p.u, 0) / n;
		const cy = target.points.reduce((acc, p) => acc + p.v, 0) / n;
		const avgR = target.points.reduce((acc, p) => acc + Math.hypot(p.u - cx, p.v - cy), 0) / n;
		const clickR = Math.hypot(clickPt.u - cx, clickPt.v - cy);
		const scale = Math.max(.2, (avgR + (clickR >= avgR ? offsetDist : -offsetDist)) / (avgR || 1));
		return [...entities, {
			...target,
			id: newId,
			points: target.points.map((p) => ({
				u: Number((cx + (p.u - cx) * scale).toFixed(1)),
				v: Number((cy + (p.v - cy) * scale).toFixed(1))
			})),
			source: "user"
		}];
	}
	return entities;
}
/**
* Compute bounding box of a view's solid & dashed entities
*/
export function getViewBounds(entities, view) {
	const solidEnts = entities.filter((e) => e.view === view && e.lineType === "thick_solid");
	const vEnts = solidEnts.length > 0 ? solidEnts : entities.filter((e) => e.view === view && e.lineType === "thin_dashed");
	if (vEnts.length === 0) return null;
	let uMin = Infinity;
	let uMax = -Infinity;
	let vMin = Infinity;
	let vMax = -Infinity;
	for (const e of vEnts) if (e.type === "circle") {
		uMin = Math.min(uMin, e.center.u - e.radius);
		uMax = Math.max(uMax, e.center.u + e.radius);
		vMin = Math.min(vMin, e.center.v - e.radius);
		vMax = Math.max(vMax, e.center.v + e.radius);
	} else if (e.type === "arc") {
		const ab = getArcExactBounds(e.center, e.radius, e.startAngle, e.endAngle);
		uMin = Math.min(uMin, ab.uMin);
		uMax = Math.max(uMax, ab.uMax);
		vMin = Math.min(vMin, ab.vMin);
		vMax = Math.max(vMax, ab.vMax);
	} else {
		const segs = expandEntityToSegments(e);
		for (const s of segs) for (const p of [s.p1, s.p2]) {
			uMin = Math.min(uMin, p.u);
			uMax = Math.max(uMax, p.u);
			vMin = Math.min(vMin, p.v);
			vMax = Math.max(vMax, p.v);
		}
	}
	if (!Number.isFinite(uMin) || !Number.isFinite(uMax) || !Number.isFinite(vMin) || !Number.isFinite(vMax)) return null;
	return {
		uMin,
		uMax,
		vMin,
		vMax
	};
}
export function getSegmentsExactBounds(segments) {
	let uMin = Infinity;
	let uMax = -Infinity;
	let vMin = Infinity;
	let vMax = -Infinity;
	for (const s of segments) if (s.kind === "arc" && s.center && s.radius !== void 0 && s.startAngle !== void 0 && s.endAngle !== void 0) {
		const ab = getArcExactBounds(s.center, s.radius, s.startAngle, s.endAngle);
		uMin = Math.min(uMin, ab.uMin);
		uMax = Math.max(uMax, ab.uMax);
		vMin = Math.min(vMin, ab.vMin);
		vMax = Math.max(vMax, ab.vMax);
	} else for (const p of [s.p1, s.p2]) {
		uMin = Math.min(uMin, p.u);
		uMax = Math.max(uMax, p.u);
		vMin = Math.min(vMin, p.v);
		vMax = Math.max(vMax, p.v);
	}
	return {
		uMin,
		uMax,
		vMin,
		vMax
	};
}
export function buildDensePolygonFromSegments(segments) {
	const polyPts: Point2D[] = [];
	const N_ARC_PTS = 48;
	let currPt: Point2D | null = null;
	for (const seg of segments) {
		if (seg.kind === "arc" && seg.center && seg.radius !== void 0 && seg.startAngle !== void 0 && seg.endAngle !== void 0) {
			let span = normalizeAngle(seg.endAngle - seg.startAngle);
			if (span < 1e-4) span = Math.PI * 2;
			const sampled: Point2D[] = [];
			for (let k = 0; k <= N_ARC_PTS; k++) {
				const frac = k / N_ARC_PTS;
				const ang = seg.startAngle + frac * span;
				sampled.push({
					u: seg.center.u + seg.radius * Math.cos(ang),
					v: seg.center.v + seg.radius * Math.sin(ang)
				});
			}
			const arcStart = sampled[0];
			const arcEnd = sampled[sampled.length - 1];
			const refPt = currPt || seg.p1 || arcStart;
			if (dist2D(arcEnd, refPt) + 1e-3 < dist2D(arcStart, refPt)) {
				sampled.reverse();
				seg.ccw = false;
				seg.p1 = arcEnd;
				seg.p2 = arcStart;
			} else {
				seg.ccw = true;
				seg.p1 = arcStart;
				seg.p2 = arcEnd;
			}
			for (const pt of sampled) {
				if (polyPts.length === 0 || dist2D(polyPts[polyPts.length - 1], pt) > 0.05) {
					polyPts.push(pt);
				}
			}
			currPt = polyPts[polyPts.length - 1] || null;
		} else if (seg.p1 && seg.p2) {
			if (currPt && dist2D(seg.p2, currPt) + 1e-3 < dist2D(seg.p1, currPt)) {
				const tmp = seg.p1;
				seg.p1 = seg.p2;
				seg.p2 = tmp;
			}
			if (polyPts.length === 0 || dist2D(polyPts[polyPts.length - 1], seg.p1) > 0.05) {
				polyPts.push(seg.p1);
			}
			if (dist2D(polyPts[polyPts.length - 1], seg.p2) > 0.05) {
				polyPts.push(seg.p2);
			}
			currPt = polyPts[polyPts.length - 1] || null;
		}
	}
	if (polyPts.length >= 2 && dist2D(polyPts[0], polyPts[polyPts.length - 1]) <= 0.1) {
		polyPts.pop();
	}
	return polyPts;
}
/**
* Stage 1: Entity Normalization & "Virtual Circle" Automatic Stitching
* - Stitches concentric equal-radius arcs (center dist <= 1.5mm, |dR| <= 1.5mm, combined coverage >= 240 deg)
*   into a complete VirtualCircle(uc, vc, R).
* - Promotes single outer-contour major arcs (thick_solid, span > 195 deg, without a direct closing flat chord)
*   into a VirtualCircle(uc, vc, R).
* - Protects any thin_dashed arc participating in a VirtualCircle by recording its ID in outProtectedDashedArcIds
*   and outStitchedArcIds so it is never misinterpreted as a subtracted hole.
*/
export function extractNormalizedCirclesInView(
	entities: any[],
	view: "front" | "top" | "left",
	outStitchedArcIds?: Set<string>,
	outProtectedDashedArcIds?: Set<string>
): any[] {
	const viewEnts = entities.filter((e) => e.view === view && e.source !== "derived" && e.lineType !== "construction");
	const realCircles = viewEnts.filter((e) => e.type === "circle").map((c) => ({
		...c,
		sourceIds: [c.id]
	}));
	const viewArcs = viewEnts.filter((e) => e.type === "arc" && (e.lineType === "thick_solid" || e.lineType === "thin_dashed"));
	const solidLines = viewEnts.filter((e) => e.type === "line" && e.lineType === "thick_solid");

	for (const arc of viewArcs) {
		if (arc.lineType === "thin_dashed") {
			const matchesRealCircle = realCircles.some(
				(c) => dist2D(c.center, arc.center) <= 1.5 && Math.abs(c.radius - arc.radius) <= 1.5
			);
			if (matchesRealCircle) {
				outStitchedArcIds?.add(arc.id);
				outProtectedDashedArcIds?.add(arc.id);
			}
		}
	}

	const groups: any[][] = [];
	for (const arc of viewArcs) {
		if (outStitchedArcIds?.has(arc.id)) continue;
		const existingGroup = groups.find(
			(g) => dist2D(g[0].center, arc.center) <= 1.5 && Math.abs(g[0].radius - arc.radius) <= 1.5
		);
		if (existingGroup) {
			existingGroup.push(arc);
		} else {
			groups.push([arc]);
		}
	}

	const computeGroupCoverageDeg = (arcGroup: any[]): number => {
		const BINS = 360;
		const covered = new Uint8Array(BINS);
		for (const a of arcGroup) {
			let start = ((a.startAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
			let end = ((a.endAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
			let span = end - start;
			if (span <= 1e-4) span += Math.PI * 2;
			const steps = Math.max(2, Math.ceil((span * 180) / Math.PI));
			for (let s = 0; s <= steps; s++) {
				const ang = (start + (span * s) / steps) % (Math.PI * 2);
				const bin = Math.floor((ang / (Math.PI * 2)) * BINS) % BINS;
				covered[bin] = 1;
			}
		}
		let count = 0;
		for (let i = 0; i < BINS; i++) count += covered[i];
		return count;
	};

	const hasDirectClosingFlatChord = (arc: any): boolean => {
		const pStart = {
			u: arc.center.u + arc.radius * Math.cos(arc.startAngle),
			v: arc.center.v + arc.radius * Math.sin(arc.startAngle)
		};
		const pEnd = {
			u: arc.center.u + arc.radius * Math.cos(arc.endAngle),
			v: arc.center.v + arc.radius * Math.sin(arc.endAngle)
		};
		if (dist2D(pStart, pEnd) <= 2.0) return false;
		return solidLines.some(
			(ln) =>
				(dist2D(ln.p1, pStart) <= 3.5 && dist2D(ln.p2, pEnd) <= 3.5) ||
				(dist2D(ln.p1, pEnd) <= 3.5 && dist2D(ln.p2, pStart) <= 3.5)
		);
	};

	const virtualCircles: any[] = [];
	for (const g of groups) {
		const avgU = g.reduce((acc, a) => acc + a.center.u, 0) / g.length;
		const avgV = g.reduce((acc, a) => acc + a.center.v, 0) / g.length;
		const avgR = g.reduce((acc, a) => acc + a.radius, 0) / g.length;
		const alreadyHasReal = realCircles.some(
			(c) => dist2D(c.center, { u: avgU, v: avgV }) <= 1.5 && Math.abs(c.radius - avgR) <= 1.5
		);
		if (alreadyHasReal) {
			for (const a of g) {
				outStitchedArcIds?.add(a.id);
				if (a.lineType === "thin_dashed") outProtectedDashedArcIds?.add(a.id);
			}
			continue;
		}

		const coverageDeg = computeGroupCoverageDeg(g);
		const isStitchedMultiArc = g.length >= 2 && coverageDeg >= 240;
		const isTrimmedMajorArc =
			g.length === 1 &&
			g[0].lineType === "thick_solid" &&
			coverageDeg > 195 &&
			!hasDirectClosingFlatChord(g[0]);

		if (isStitchedMultiArc || isTrimmedMajorArc) {
			const hasSolid = g.some((a) => a.lineType === "thick_solid");
			const sourceIds = g.map((a) => a.id);
			for (const a of g) {
				outStitchedArcIds?.add(a.id);
				if (a.lineType === "thin_dashed") outProtectedDashedArcIds?.add(a.id);
			}
			virtualCircles.push({
				id: g[0].id,
				sourceIds,
				view,
				type: "circle",
				lineType: hasSolid ? "thick_solid" : "thin_dashed",
				center: { u: avgU, v: avgV },
				radius: avgR,
				isVirtualCircle: true
			});
		}
	}

	return [...realCircles, ...virtualCircles];
}

/**
* Stage 2 Helper: Decompose composite outer loops (such as a triangle/trapezoid/rectangle
* stepping inward at W = w_split to join a protruding semicircle arc, or split by an internal dividing line)
* into independent elementary sub-loops.
*/
export function decomposeCompositeLoopsInView(loops: any[], viewSolidLines: any[] = []): any[] {
	const result: any[] = [];
	const buildLoopFromSegs = (segs: any[], lineType: string) => {
		const polyPts = buildDensePolygonFromSegments(segs);
		if (polyPts.length < 3) return null;
		const { uMin, uMax, vMin, vMax } = getSegmentsExactBounds(segs);
		if (uMax - uMin <= 1 || vMax - vMin <= 1) return null;
		return {
			points: polyPts,
			segments: segs,
			uMin,
			uMax,
			vMin,
			vMax,
			area: polygonArea2D(polyPts),
			lineType
		};
	};

	for (const lp of loops) {
		if (lp.lineType !== "thick_solid" || !Array.isArray(lp.segments) || lp.segments.length < 3) {
			result.push(lp);
			continue;
		}
		const arcSegs = lp.segments.filter((s: any) => s.kind === "arc" && s.center && s.radius !== void 0);
		const lineSegs = lp.segments.filter((s: any) => s.kind === "line");

		if (arcSegs.length === 1 && lineSegs.length >= 2) {
			const arcSeg = arcSegs[0];
			const dv = Math.abs(arcSeg.p1.v - arcSeg.p2.v);
			const du = Math.abs(arcSeg.p1.u - arcSeg.p2.u);

			if (dv <= 3.0 && du > 3.0) {
				const rawV = 0.5 * (arcSeg.p1.v + arcSeg.p2.v);
				const vSplit = Math.abs(rawV - arcSeg.center.v) <= 3.5 ? arcSeg.center.v : rawV;
				const hasBodyBelow = lp.vMin < vSplit - 2.5 && lp.vMax > vSplit + 2.5;
				if (hasBodyBelow) {
					const pArc1 = { u: arcSeg.p1.u, v: vSplit };
					const pArc2 = { u: arcSeg.p2.u, v: vSplit };
					const semiLoop = buildLoopFromSegs(
						[
							{ ...arcSeg, p1: pArc1, p2: pArc2 },
							{ kind: "line", p1: pArc2, p2: pArc1 }
						],
						lp.lineType
					);

					const bodyRawSegs = lineSegs
						.filter((s: any) => !(Math.abs(s.p1.v - vSplit) <= 3.0 && Math.abs(s.p2.v - vSplit) <= 3.0))
						.map((s: any) => ({
							...s,
							p1: Math.abs(s.p1.v - vSplit) <= 3.0 ? { u: s.p1.u, v: vSplit } : s.p1,
							p2: Math.abs(s.p2.v - vSplit) <= 3.0 ? { u: s.p2.u, v: vSplit } : s.p2
						}));

					if (semiLoop && bodyRawSegs.length >= 2) {
						const orderedBody: any[] = [{ ...bodyRawSegs[0] }];
						const usedBody = new Set<number>([0]);
						let grew = true;
						while (grew) {
							grew = false;
							const tail = orderedBody[orderedBody.length - 1].p2;
							const head = orderedBody[0].p1;
							for (let idx = 0; idx < bodyRawSegs.length; idx++) {
								if (usedBody.has(idx)) continue;
								const cand = bodyRawSegs[idx];
								if (dist2D(tail, cand.p1) <= 2.5) {
									orderedBody.push({ ...cand });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(tail, cand.p2) <= 2.5) {
									orderedBody.push({ ...cand, p1: cand.p2, p2: cand.p1 });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(head, cand.p2) <= 2.5) {
									orderedBody.unshift({ ...cand });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(head, cand.p1) <= 2.5) {
									orderedBody.unshift({ ...cand, p1: cand.p2, p2: cand.p1 });
									usedBody.add(idx);
									grew = true;
									break;
								}
							}
						}
						const bHead = orderedBody[0].p1;
						const bTail = orderedBody[orderedBody.length - 1].p2;
						if (dist2D(bTail, bHead) > 1.0) {
							orderedBody.push({ kind: "line", p1: bTail, p2: bHead });
						}
						const bodyLoop = buildLoopFromSegs(orderedBody, lp.lineType);
						if (bodyLoop) {
							result.push(bodyLoop, semiLoop);
							continue;
						}
					}
				}
			} else if (du <= 3.0 && dv > 3.0) {
				const rawU = 0.5 * (arcSeg.p1.u + arcSeg.p2.u);
				const uSplit = Math.abs(rawU - arcSeg.center.u) <= 3.5 ? arcSeg.center.u : rawU;
				const hasBodySide = lp.uMin < uSplit - 2.5 && lp.uMax > uSplit + 2.5;
				if (hasBodySide) {
					const pArc1 = { u: uSplit, v: arcSeg.p1.v };
					const pArc2 = { u: uSplit, v: arcSeg.p2.v };
					const semiLoop = buildLoopFromSegs(
						[
							{ ...arcSeg, p1: pArc1, p2: pArc2 },
							{ kind: "line", p1: pArc2, p2: pArc1 }
						],
						lp.lineType
					);

					const bodyRawSegs = lineSegs
						.filter((s: any) => !(Math.abs(s.p1.u - uSplit) <= 3.0 && Math.abs(s.p2.u - uSplit) <= 3.0))
						.map((s: any) => ({
							...s,
							p1: Math.abs(s.p1.u - uSplit) <= 3.0 ? { u: uSplit, v: s.p1.v } : s.p1,
							p2: Math.abs(s.p2.u - uSplit) <= 3.0 ? { u: uSplit, v: s.p2.v } : s.p2
						}));

					if (semiLoop && bodyRawSegs.length >= 2) {
						const orderedBody: any[] = [{ ...bodyRawSegs[0] }];
						const usedBody = new Set<number>([0]);
						let grew = true;
						while (grew) {
							grew = false;
							const tail = orderedBody[orderedBody.length - 1].p2;
							const head = orderedBody[0].p1;
							for (let idx = 0; idx < bodyRawSegs.length; idx++) {
								if (usedBody.has(idx)) continue;
								const cand = bodyRawSegs[idx];
								if (dist2D(tail, cand.p1) <= 2.5) {
									orderedBody.push({ ...cand });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(tail, cand.p2) <= 2.5) {
									orderedBody.push({ ...cand, p1: cand.p2, p2: cand.p1 });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(head, cand.p2) <= 2.5) {
									orderedBody.unshift({ ...cand });
									usedBody.add(idx);
									grew = true;
									break;
								} else if (dist2D(head, cand.p1) <= 2.5) {
									orderedBody.unshift({ ...cand, p1: cand.p2, p2: cand.p1 });
									usedBody.add(idx);
									grew = true;
									break;
								}
							}
						}
						const bHead = orderedBody[0].p1;
						const bTail = orderedBody[orderedBody.length - 1].p2;
						if (dist2D(bTail, bHead) > 1.0) {
							orderedBody.push({ kind: "line", p1: bTail, p2: bHead });
						}
						const bodyLoop = buildLoopFromSegs(orderedBody, lp.lineType);
						if (bodyLoop) {
							result.push(bodyLoop, semiLoop);
							continue;
						}
					}
				}
			}
		}

		// Also check if a non-rectangular all-line loop has internal horizontal/vertical dividing lines or step-shoulders
		const isSimpleAxisRect =
			arcSegs.length === 0 &&
			lineSegs.length === 4 &&
			Math.abs(lp.area - (lp.uMax - lp.uMin) * (lp.vMax - lp.vMin)) <= 2.0;
		if (arcSegs.length === 0 && lineSegs.length >= 3 && !isSimpleAxisRect) {
			const clipPolyByV = (pts: { u: number; v: number }[], vCut: number, keepGreater: boolean) => {
				const out: { u: number; v: number }[] = [];
				for (let i = 0; i < pts.length; i++) {
					const cur = pts[i];
					const nxt = pts[(i + 1) % pts.length];
					const curIn = keepGreater ? cur.v >= vCut - 1e-4 : cur.v <= vCut + 1e-4;
					const nxtIn = keepGreater ? nxt.v >= vCut - 1e-4 : nxt.v <= vCut + 1e-4;
					if (curIn) out.push(cur);
					if (curIn !== nxtIn && Math.abs(nxt.v - cur.v) > 1e-5) {
						const t = (vCut - cur.v) / (nxt.v - cur.v);
						out.push({ u: cur.u + t * (nxt.u - cur.u), v: vCut });
					}
				}
				const dedup: { u: number; v: number }[] = [];
				for (const p of out) {
					if (dedup.length === 0 || dist2D(dedup[dedup.length - 1], p) > 0.5) dedup.push(p);
				}
				if (dedup.length >= 2 && dist2D(dedup[0], dedup[dedup.length - 1]) <= 0.5) dedup.pop();
				return dedup;
			};

			const clipPolyByU = (pts: { u: number; v: number }[], uCut: number, keepGreater: boolean) => {
				const out: { u: number; v: number }[] = [];
				for (let i = 0; i < pts.length; i++) {
					const cur = pts[i];
					const nxt = pts[(i + 1) % pts.length];
					const curIn = keepGreater ? cur.u >= uCut - 1e-4 : cur.u <= uCut + 1e-4;
					const nxtIn = keepGreater ? nxt.u >= uCut - 1e-4 : nxt.u <= uCut + 1e-4;
					if (curIn) out.push(cur);
					if (curIn !== nxtIn && Math.abs(nxt.u - cur.u) > 1e-5) {
						const t = (uCut - cur.u) / (nxt.u - cur.u);
						out.push({ u: uCut, v: cur.v + t * (nxt.v - cur.v) });
					}
				}
				const dedup: { u: number; v: number }[] = [];
				for (const p of out) {
					if (dedup.length === 0 || dist2D(dedup[dedup.length - 1], p) > 0.5) dedup.push(p);
				}
				if (dedup.length >= 2 && dist2D(dedup[0], dedup[dedup.length - 1]) <= 0.5) dedup.pop();
				return dedup;
			};

			let splitDone = false;
			const internalHorizSplits: number[] = [];
			for (const s of lineSegs) {
				if (Math.abs(s.p1.v - s.p2.v) <= 1.5 && Math.abs(s.p1.u - s.p2.u) > 2.0) {
					const vVal = 0.5 * (s.p1.v + s.p2.v);
					if (vVal > lp.vMin + 2.5 && vVal < lp.vMax - 2.5) {
						if (!internalHorizSplits.some((v) => Math.abs(v - vVal) <= 2.0)) internalHorizSplits.push(vVal);
					}
				}
			}
			for (const ln of viewSolidLines) {
				if (Math.abs(ln.p1.v - ln.p2.v) <= 1.5 && Math.abs(ln.p1.u - ln.p2.u) > 3.0) {
					const vVal = 0.5 * (ln.p1.v + ln.p2.v);
					if (
						vVal > lp.vMin + 2.5 &&
						vVal < lp.vMax - 2.5 &&
						Math.min(ln.p1.u, ln.p2.u) >= lp.uMin - 2.0 &&
						Math.max(ln.p1.u, ln.p2.u) <= lp.uMax + 2.0
					) {
						const alreadySubLoops = loops.filter(
							(other) =>
								other !== lp &&
								(Math.abs(other.vMax - vVal) <= 2.0 || Math.abs(other.vMin - vVal) <= 2.0)
						);
						if (alreadySubLoops.length < 2 && !internalHorizSplits.some((v) => Math.abs(v - vVal) <= 2.0)) {
							internalHorizSplits.push(vVal);
						}
					}
				}
			}

			if (internalHorizSplits.length === 1) {
				const vCut = internalHorizSplits[0];
				const ptsLow = clipPolyByV(lp.points, vCut, false);
				const ptsHigh = clipPolyByV(lp.points, vCut, true);
				if (ptsLow.length >= 3 && ptsHigh.length >= 3) {
					const lpLow = buildLoopFromSegs(
						ptsLow.map((p, i) => ({ kind: "line", p1: p, p2: ptsLow[(i + 1) % ptsLow.length] })),
						lp.lineType
					);
					const lpHigh = buildLoopFromSegs(
						ptsHigh.map((p, i) => ({ kind: "line", p1: p, p2: ptsHigh[(i + 1) % ptsHigh.length] })),
						lp.lineType
					);
					if (lpLow && lpHigh && lpLow.area > 4 && lpHigh.area > 4) {
						(lpLow as any).isDecomposedSubLoop = true;
						(lpHigh as any).isDecomposedSubLoop = true;
						result.push(lp, lpLow, lpHigh);
						splitDone = true;
					}
				}
			}

			if (!splitDone) {
				const internalVertSplits: number[] = [];
				for (const s of lineSegs) {
					if (Math.abs(s.p1.u - s.p2.u) <= 1.5 && Math.abs(s.p1.v - s.p2.v) > 2.0) {
						const uVal = 0.5 * (s.p1.u + s.p2.u);
						if (uVal > lp.uMin + 2.5 && uVal < lp.uMax - 2.5) {
							if (!internalVertSplits.some((u) => Math.abs(u - uVal) <= 2.0)) internalVertSplits.push(uVal);
						}
					}
				}
				if (internalVertSplits.length === 1) {
					const uCut = internalVertSplits[0];
					const ptsLeft = clipPolyByU(lp.points, uCut, false);
					const ptsRight = clipPolyByU(lp.points, uCut, true);
					if (ptsLeft.length >= 3 && ptsRight.length >= 3) {
						const lpLeft = buildLoopFromSegs(
							ptsLeft.map((p, i) => ({ kind: "line", p1: p, p2: ptsLeft[(i + 1) % ptsLeft.length] })),
							lp.lineType
						);
						const lpRight = buildLoopFromSegs(
							ptsRight.map((p, i) => ({ kind: "line", p1: p, p2: ptsRight[(i + 1) % ptsRight.length] })),
							lp.lineType
						);
						if (lpLeft && lpRight && lpLeft.area > 4 && lpRight.area > 4) {
							(lpLeft as any).isDecomposedSubLoop = true;
							(lpRight as any).isDecomposedSubLoop = true;
							result.push(lp, lpLeft, lpRight);
							splitDone = true;
						}
					}
				}
			}

			if (splitDone) continue;
		}

		result.push(lp);
	}

	return result.sort((a, b) => b.area - a.area);
}

/**
* Extract closed 2D loops from a view's entities (supporting both thick_solid and thin_dashed)
* while preserving exact analytical `line` and `arc` segments (`LoopCurveSegment2D`).
*/
export function extractClosedLoopsInView(
	entities: any[],
	view: "front" | "top" | "left",
	allowedLineTypes = ["thick_solid"],
	ignoredArcIds?: Set<string>
) {
	const loops: any[] = [];
	const viewEnts = entities.filter(
		(e) =>
			e.view === view &&
			e.source !== "derived" &&
			allowedLineTypes.includes(e.lineType) &&
			!(e.type === "arc" && ignoredArcIds?.has(e.id))
	);
	const usedArcIds = /* @__PURE__ */ new Set();
	for (const e of viewEnts) if (e.type === "rect" && e.width > .5 && e.height > .5) {
		const pts = [
			{
				u: e.x,
				v: e.y
			},
			{
				u: e.x + e.width,
				v: e.y
			},
			{
				u: e.x + e.width,
				v: e.y + e.height
			},
			{
				u: e.x,
				v: e.y + e.height
			}
		];
		const segs = [
			{
				kind: "line",
				p1: pts[0],
				p2: pts[1]
			},
			{
				kind: "line",
				p1: pts[1],
				p2: pts[2]
			},
			{
				kind: "line",
				p1: pts[2],
				p2: pts[3]
			},
			{
				kind: "line",
				p1: pts[3],
				p2: pts[0]
			}
		];
		loops.push({
			points: pts,
			segments: segs,
			uMin: e.x,
			uMax: e.x + e.width,
			vMin: e.y,
			vMax: e.y + e.height,
			area: e.width * e.height,
			lineType: e.lineType
		});
	} else if (e.type === "polygon" && e.closed !== false && e.points.length >= 3) {
		const us = e.points.map((p: any) => p.u);
		const vs = e.points.map((p: any) => p.v);
		const segs = e.points.map((pt: any, idx: number) => ({
			kind: "line",
			p1: pt,
			p2: e.points[(idx + 1) % e.points.length]
		}));
		loops.push({
			points: e.points,
			segments: segs,
			uMin: Math.min(...us),
			uMax: Math.max(...us),
			vMin: Math.min(...vs),
			vMax: Math.max(...vs),
			area: polygonArea2D(e.points),
			lineType: e.lineType
		});
	}
	for (const lt of allowedLineTypes) {
		const segEnts = viewEnts.filter((e) => e.lineType === lt && (e.type === "line" || e.type === "arc"));
		const rawSegs: any[] = [];
		for (const e of segEnts) if (e.type === "line") {
			if (dist2D(e.p1, e.p2) >= .3) rawSegs.push({
				kind: "line",
				p1: e.p1,
				p2: e.p2,
				entityId: e.id
			});
		} else if (e.type === "arc") {
			const pStart = {
				u: e.center.u + e.radius * Math.cos(e.startAngle),
				v: e.center.v + e.radius * Math.sin(e.startAngle)
			};
			const pEnd = {
				u: e.center.u + e.radius * Math.cos(e.endAngle),
				v: e.center.v + e.radius * Math.sin(e.endAngle)
			};
			if (dist2D(pStart, pEnd) >= .3) rawSegs.push({
				kind: "arc",
				p1: pStart,
				p2: pEnd,
				center: e.center,
				radius: e.radius,
				startAngle: e.startAngle,
				endAngle: e.endAngle,
				ccw: true,
				entityId: e.id
			});
		}
		const used = /* @__PURE__ */ new Set();
		const SNAP_TOL = 1.6;
		const ARC_SNAP_TOL = 3.5;
		for (let i = 0; i < rawSegs.length; i++) {
			if (used.has(i)) continue;
			const chain = [{ ...rawSegs[i] }];
			used.add(i);
			let grew = true;
			while (grew) {
				grew = false;
				const head = chain[0].p1;
				const tail = chain[chain.length - 1].p2;
				const hasArc = chain.some((s) => s.kind === "arc");
				const closeTol = hasArc ? ARC_SNAP_TOL : SNAP_TOL;
				if ((chain.length >= 3 || chain.length >= 2 && hasArc) && dist2D(tail, head) <= closeTol) break;
				for (let j = 0; j < rawSegs.length; j++) {
					if (used.has(j)) continue;
					const s = rawSegs[j];
					const pairTol = hasArc || s.kind === "arc" ? ARC_SNAP_TOL : SNAP_TOL;
					if (dist2D(tail, s.p1) <= pairTol) {
						chain.push({ ...s });
						used.add(j);
						grew = true;
						break;
					} else if (dist2D(tail, s.p2) <= pairTol) {
						chain.push({
							...s,
							p1: s.p2,
							p2: s.p1,
							ccw: s.kind === "arc" ? false : void 0
						});
						used.add(j);
						grew = true;
						break;
					} else if (chain.length === 1 && dist2D(head, s.p1) <= pairTol) {
						chain[0] = {
							...chain[0],
							p1: chain[0].p2,
							p2: chain[0].p1,
							ccw: chain[0].kind === "arc" ? false : void 0
						};
						chain.push({ ...s });
						used.add(j);
						grew = true;
						break;
					} else if (chain.length === 1 && dist2D(head, s.p2) <= pairTol) {
						chain[0] = {
							...chain[0],
							p1: chain[0].p2,
							p2: chain[0].p1,
							ccw: chain[0].kind === "arc" ? false : void 0
						};
						chain.push({
							...s,
							p1: s.p2,
							p2: s.p1,
							ccw: s.kind === "arc" ? false : void 0
						});
						used.add(j);
						grew = true;
						break;
					}
				}
			}
			const head = chain[0].p1;
			const tail = chain[chain.length - 1].p2;
			const hasArc = chain.some((s) => s.kind === "arc");
			const closeTol = hasArc ? ARC_SNAP_TOL : SNAP_TOL;
			if ((chain.length >= 3 || chain.length >= 2 && hasArc) && dist2D(tail, head) <= closeTol) {
				for (const s of chain) if (s.kind === "arc") usedArcIds.add(s.entityId);
				if (chain.length === 2 && hasArc) {
					const arcSeg = chain.find((s) => s.kind === "arc");
					const lnSeg = chain.find((s) => s.kind === "line");
					if (arcSeg && lnSeg && arcSeg.center && arcSeg.radius !== void 0) {
						if (Math.abs(lnSeg.p1.v - lnSeg.p2.v) <= 3.0 && Math.abs(0.5 * (lnSeg.p1.v + lnSeg.p2.v) - arcSeg.center.v) <= 3.5) {
							const vFlat = arcSeg.center.v;
							lnSeg.p1 = { u: lnSeg.p1.u, v: vFlat };
							lnSeg.p2 = { u: lnSeg.p2.u, v: vFlat };
							arcSeg.p1 = { u: arcSeg.p1.u, v: vFlat };
							arcSeg.p2 = { u: arcSeg.p2.u, v: vFlat };
						} else if (Math.abs(lnSeg.p1.u - lnSeg.p2.u) <= 3.0 && Math.abs(0.5 * (lnSeg.p1.u + lnSeg.p2.u) - arcSeg.center.u) <= 3.5) {
							const uFlat = arcSeg.center.u;
							lnSeg.p1 = { u: uFlat, v: lnSeg.p1.v };
							lnSeg.p2 = { u: uFlat, v: lnSeg.p2.v };
							arcSeg.p1 = { u: uFlat, v: arcSeg.p1.v };
							arcSeg.p2 = { u: uFlat, v: arcSeg.p2.v };
						}
					}
				}
				const cleanSegs = chain.map((s) => ({
					kind: s.kind,
					p1: s.p1,
					p2: s.p2,
					center: s.center,
					radius: s.radius,
					startAngle: s.startAngle,
					endAngle: s.endAngle,
					ccw: s.ccw
				}));
				const polyPts = buildDensePolygonFromSegments(cleanSegs);
				if (polyPts.length >= 3) {
					const { uMin, uMax, vMin, vMax } = getSegmentsExactBounds(cleanSegs);
					if (uMax - uMin > 1 && vMax - vMin > 1) loops.push({
						points: polyPts,
						segments: cleanSegs,
						uMin,
						uMax,
						vMin,
						vMax,
						area: polygonArea2D(polyPts),
						lineType: lt
					});
				}
			}
		}
		if (lt === "thick_solid") {
			const solidLinesOnly = segEnts.filter((e) => e.type === "line") as CadLineEntity[];
			const hasSolidArc = segEnts.some((e) => e.type === "arc");
			if (!hasSolidArc && solidLinesOnly.length >= 4) {
				let buMin = Infinity, buMax = -Infinity, bvMin = Infinity, bvMax = -Infinity;
				for (const ln of solidLinesOnly) {
					buMin = Math.min(buMin, ln.p1.u, ln.p2.u);
					buMax = Math.max(buMax, ln.p1.u, ln.p2.u);
					bvMin = Math.min(bvMin, ln.p1.v, ln.p2.v);
					bvMax = Math.max(bvMax, ln.p1.v, ln.p2.v);
				}
				if (buMax - buMin > 2 && bvMax - bvMin > 2) {
					const hasTopEdge = solidLinesOnly.some((l) => Math.abs(l.p1.v - bvMax) <= 1.5 && Math.abs(l.p2.v - bvMax) <= 1.5 && Math.abs(l.p2.u - l.p1.u) > 2);
					const hasBotEdge = solidLinesOnly.some((l) => Math.abs(l.p1.v - bvMin) <= 1.5 && Math.abs(l.p2.v - bvMin) <= 1.5 && Math.abs(l.p2.u - l.p1.u) > 2);
					const hasLeftEdge = solidLinesOnly.some((l) => Math.abs(l.p1.u - buMin) <= 1.5 && Math.abs(l.p2.u - buMin) <= 1.5 && Math.abs(l.p2.v - l.p1.v) > 2);
					const hasRightEdge = solidLinesOnly.some((l) => Math.abs(l.p1.u - buMax) <= 1.5 && Math.abs(l.p2.u - buMax) <= 1.5 && Math.abs(l.p2.v - l.p1.v) > 2);
					const alreadyHasOuter = loops.some((lp) => lp.lineType === "thick_solid" && Math.abs(lp.uMin - buMin) <= 1.5 && Math.abs(lp.uMax - buMax) <= 1.5 && Math.abs(lp.vMin - bvMin) <= 1.5 && Math.abs(lp.vMax - bvMax) <= 1.5 && lp.area >= 0.95 * (buMax - buMin) * (bvMax - bvMin));
					if (hasTopEdge && hasBotEdge && hasLeftEdge && hasRightEdge && !alreadyHasOuter) {
						const envPts = [
							{ u: buMin, v: bvMin },
							{ u: buMax, v: bvMin },
							{ u: buMax, v: bvMax },
							{ u: buMin, v: bvMax }
						];
						loops.push({
							points: envPts,
							segments: envPts.map((pt, idx) => ({
								kind: "line",
								p1: pt,
								p2: envPts[(idx + 1) % 4]
							})),
							uMin: buMin,
							uMax: buMax,
							vMin: bvMin,
							vMax: bvMax,
							area: (buMax - buMin) * (bvMax - bvMin),
							lineType: "thick_solid"
						});
					}
				}
			}
		}
	}
	const unconsumedArcs = viewEnts.filter((e) => e.type === "arc" && !usedArcIds.has(e.id));
	if (unconsumedArcs.length > 0 && loops.length > 0) for (const arcEnt of unconsumedArcs) {
		const pStart = {
			u: arcEnt.center.u + arcEnt.radius * Math.cos(arcEnt.startAngle),
			v: arcEnt.center.v + arcEnt.radius * Math.sin(arcEnt.startAngle)
		};
		const pEnd = {
			u: arcEnt.center.u + arcEnt.radius * Math.cos(arcEnt.endAngle),
			v: arcEnt.center.v + arcEnt.radius * Math.sin(arcEnt.endAngle)
		};
		const rawSpan = ((arcEnt.endAngle - arcEnt.startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
		const midAng = arcEnt.startAngle + 0.5 * (rawSpan > 1e-4 ? rawSpan : Math.PI);
		const pMid = {
			u: arcEnt.center.u + arcEnt.radius * Math.cos(midAng),
			v: arcEnt.center.v + arcEnt.radius * Math.sin(midAng)
		};
		const existingLoopsSnapshot = [...loops];
		for (const lp of existingLoopsSnapshot) {
			if (lp.lineType !== arcEnt.lineType) continue;
			let handled = false;
			const nextSegs = [];
			for (const seg of lp.segments) {
				if (!handled && seg.kind === "line") {
					const d1 = pointToSegmentDist(pStart, seg.p1, seg.p2);
					const d2 = pointToSegmentDist(pEnd, seg.p1, seg.p2);
					if (d1.dist <= 3.5 && d2.dist <= 3.5 && Math.abs(d1.t - d2.t) > .05) {
						const isProtrudingOutward = !pointInPolygon2D(pMid, lp.points);
						if (isProtrudingOutward && arcEnt.lineType === "thick_solid") {
							// Outward boss/semicircle attached to polygon edge: keep lp intact and create an independent semicircle loop!
							let cP1 = { ...pStart };
							let cP2 = { ...pEnd };
							if (Math.abs(pStart.v - pEnd.v) <= 3.0) {
								const vFlat = Math.abs(0.5 * (pStart.v + pEnd.v) - arcEnt.center.v) <= 3.5 ? arcEnt.center.v : 0.5 * (pStart.v + pEnd.v);
								cP1 = { u: pStart.u, v: vFlat };
								cP2 = { u: pEnd.u, v: vFlat };
							} else if (Math.abs(pStart.u - pEnd.u) <= 3.0) {
								const uFlat = Math.abs(0.5 * (pStart.u + pEnd.u) - arcEnt.center.u) <= 3.5 ? arcEnt.center.u : 0.5 * (pStart.u + pEnd.u);
								cP1 = { u: uFlat, v: pStart.v };
								cP2 = { u: uFlat, v: pEnd.v };
							}
							const semiSegs = [
								{
									kind: "arc",
									p1: cP1,
									p2: cP2,
									center: arcEnt.center,
									radius: arcEnt.radius,
									startAngle: arcEnt.startAngle,
									endAngle: arcEnt.endAngle,
									ccw: true
								},
								{
									kind: "line",
									p1: cP2,
									p2: cP1
								}
							];
							const semiPts = buildDensePolygonFromSegments(semiSegs);
							if (semiPts.length >= 3) {
								const sb = getSegmentsExactBounds(semiSegs);
								loops.push({
									points: semiPts,
									segments: semiSegs,
									uMin: sb.uMin,
									uMax: sb.uMax,
									vMin: sb.vMin,
									vMax: sb.vMax,
									area: polygonArea2D(semiPts),
									lineType: arcEnt.lineType
								});
								handled = true;
							}
						} else {
							handled = true;
							if (d1.t <= d2.t) {
								if (dist2D(seg.p1, pStart) > .5) nextSegs.push({
									kind: "line",
									p1: seg.p1,
									p2: pStart
								});
								nextSegs.push({
									kind: "arc",
									p1: pStart,
									p2: pEnd,
									center: arcEnt.center,
									radius: arcEnt.radius,
									startAngle: arcEnt.startAngle,
									endAngle: arcEnt.endAngle,
									ccw: true
								});
								if (dist2D(pEnd, seg.p2) > .5) nextSegs.push({
									kind: "line",
									p1: pEnd,
									p2: seg.p2
								});
							} else {
								if (dist2D(seg.p1, pEnd) > .5) nextSegs.push({
									kind: "line",
									p1: seg.p1,
									p2: pEnd
								});
								nextSegs.push({
									kind: "arc",
									p1: pEnd,
									p2: pStart,
									center: arcEnt.center,
									radius: arcEnt.radius,
									startAngle: arcEnt.startAngle,
									endAngle: arcEnt.endAngle,
									ccw: false
								});
								if (dist2D(pStart, seg.p2) > .5) nextSegs.push({
									kind: "line",
									p1: pStart,
									p2: seg.p2
								});
							}
							continue;
						}
					}
				}
				nextSegs.push(seg);
			}
			if (handled) {
				if (nextSegs.length !== lp.segments.length || nextSegs.some((s, idx) => s !== lp.segments[idx])) {
					lp.segments = nextSegs;
					lp.points = buildDensePolygonFromSegments(nextSegs);
					const sb = getSegmentsExactBounds(nextSegs);
					lp.uMin = sb.uMin;
					lp.uMax = sb.uMax;
					lp.vMin = sb.vMin;
					lp.vMax = sb.vMax;
					lp.area = polygonArea2D(lp.points);
				}
				break;
			}
		}
	}
	const solidLinesInView = viewEnts.filter((e) => e.lineType === "thick_solid" && e.type === "line");
	const finalLoops = allowedLineTypes.includes("thick_solid")
		? decomposeCompositeLoopsInView(loops, solidLinesInView)
		: loops;
	return finalLoops.sort((a, b) => b.area - a.area);
}
/**
* Extract 3-sided open U-slots or parallel dashed line pairs in a view
*/
export function extractOpenSlotsAndDashedBandsInView(entities, view, viewBounds) {
	const viewUserEnts = entities.filter((e) => e.view === view && e.source !== "derived");
	const dashedLines = viewUserEnts.filter((e) => (e.lineType === "thin_dashed" || e.lineType === "thick_solid") && e.type === "line");
	const onlyDashed = dashedLines.filter((e) => e.lineType === "thin_dashed");
	const onlySolid = dashedLines.filter((e) => e.lineType === "thick_solid");
	const solidSegs = viewUserEnts.filter((e) => e.lineType === "thick_solid" && (e.type === "line" || e.type === "rect" || e.type === "polygon")).flatMap((e) => expandEntityToSegments(e));
	const solidCurves = viewUserEnts.filter((e) => e.lineType === "thick_solid" && (e.type === "circle" || e.type === "arc"));
	const isTouchingSolidBoundary = (pt, tol = 2.5) => {
		for (const s of solidSegs) {
			if (pointToSegmentDist(pt, s.p1, s.p2).dist <= tol) return true;
		}
		for (const c of solidCurves) {
			if (c.center && c.radius !== void 0 && Math.abs(dist2D(pt, c.center) - c.radius) <= tol) return true;
		}
		if (viewBounds) {
			if (Math.abs(pt.u - viewBounds.uMin) <= tol || Math.abs(pt.u - viewBounds.uMax) <= tol || Math.abs(pt.v - viewBounds.vMin) <= tol || Math.abs(pt.v - viewBounds.vMax) <= tol) return true;
		}
		return false;
	};
	const rawVertDashed = [];
	const rawHorizDashed = [];
	const slantedDashed = [];
	const rawVertSolid = [];
	const rawHorizSolid = [];
	for (const ln of onlyDashed) if (Math.abs(ln.p1.u - ln.p2.u) <= 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) rawVertDashed.push({
		u: .5 * (ln.p1.u + ln.p2.u),
		vMin: Math.min(ln.p1.v, ln.p2.v),
		vMax: Math.max(ln.p1.v, ln.p2.v),
		id: ln.id
	});
	else if (Math.abs(ln.p1.v - ln.p2.v) <= 1.5 && Math.abs(ln.p1.u - ln.p2.u) > 1.5) rawHorizDashed.push({
		v: .5 * (ln.p1.v + ln.p2.v),
		uMin: Math.min(ln.p1.u, ln.p2.u),
		uMax: Math.max(ln.p1.u, ln.p2.u),
		id: ln.id
	});
	else if (Math.abs(ln.p1.u - ln.p2.u) > 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) slantedDashed.push({
		p1: ln.p1,
		p2: ln.p2,
		id: ln.id
	});
	for (const ln of onlySolid) if (Math.abs(ln.p1.u - ln.p2.u) <= 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) {
		const u = .5 * (ln.p1.u + ln.p2.u);
		if (u > viewBounds.uMin + 1.5 && u < viewBounds.uMax - 1.5) rawVertSolid.push({
			u,
			vMin: Math.min(ln.p1.v, ln.p2.v),
			vMax: Math.max(ln.p1.v, ln.p2.v)
		});
	} else if (Math.abs(ln.p1.v - ln.p2.v) <= 1.5 && Math.abs(ln.p1.u - ln.p2.u) > 1.5) {
		const v = .5 * (ln.p1.v + ln.p2.v);
		if (v > viewBounds.vMin + 1.5 && v < viewBounds.vMax - 1.5) rawHorizSolid.push({
			v,
			uMin: Math.min(ln.p1.u, ln.p2.u),
			uMax: Math.max(ln.p1.u, ln.p2.u)
		});
	}
	const vertDashed = [];
	const sortedVert = [...rawVertDashed].sort((a, b) => a.u - b.u || a.vMin - b.vMin);
	for (const seg of sortedVert) {
		const prev = vertDashed[vertDashed.length - 1];
		if (prev && Math.abs(prev.u - seg.u) <= 1.2 && seg.vMin <= prev.vMax + 1) {
			prev.u = .5 * (prev.u + seg.u);
			prev.vMin = Math.min(prev.vMin, seg.vMin);
			prev.vMax = Math.max(prev.vMax, seg.vMax);
		} else vertDashed.push({ ...seg });
	}
	const horizDashed = [];
	const sortedHoriz = [...rawHorizDashed].sort((a, b) => a.v - b.v || a.uMin - b.uMin);
	for (const seg of sortedHoriz) {
		const prev = horizDashed[horizDashed.length - 1];
		if (prev && Math.abs(prev.v - seg.v) <= 1.2 && seg.uMin <= prev.uMax + 1) {
			prev.v = .5 * (prev.v + seg.v);
			prev.uMin = Math.min(prev.uMin, seg.uMin);
			prev.uMax = Math.max(prev.uMax, seg.uMax);
		} else horizDashed.push({ ...seg });
	}
	const hasSlantedBridge = (ptA, ptB, tol = 3.5) => slantedDashed.some((s) => dist2D(s.p1, ptA) <= tol && dist2D(s.p2, ptB) <= tol || dist2D(s.p1, ptB) <= tol && dist2D(s.p2, ptA) <= tol);
	const consumedVertIdx = /* @__PURE__ */ new Set();
	const consumedHorizIdx = /* @__PURE__ */ new Set();
	const uSlots = [];
	const uBands = [];
	const vBands = [];
	const solidUBands = [];
	const solidVBands = [];
	for (let i = 0; i < vertDashed.length; i++) for (let j = i + 1; j < vertDashed.length; j++) {
		const a = vertDashed[i];
		const b = vertDashed[j];
		const leftSeg = a.u <= b.u ? a : b;
		const rightSeg = a.u <= b.u ? b : a;
		const u1 = leftSeg.u;
		const u2 = rightSeg.u;
		if (u2 - u1 < 1.5) continue;
		const botTouchA = isTouchingSolidBoundary({ u: leftSeg.u, v: leftSeg.vMin }, 2.5);
		const botTouchB = isTouchingSolidBoundary({ u: rightSeg.u, v: rightSeg.vMin }, 2.5);
		const topTouchA = isTouchingSolidBoundary({ u: leftSeg.u, v: leftSeg.vMax }, 2.5);
		const topTouchB = isTouchingSolidBoundary({ u: rightSeg.u, v: rightSeg.vMax }, 2.5);
		const botAligned = Math.abs(leftSeg.vMin - rightSeg.vMin) <= 3.5 || botTouchA && botTouchB;
		const topAligned = Math.abs(leftSeg.vMax - rightSeg.vMax) <= 3.5 || topTouchA && topTouchB;
		if (botAligned && topAligned) {
			const vMin = Math.min(leftSeg.vMin, rightSeg.vMin);
			const vMax = Math.max(leftSeg.vMax, rightSeg.vMax);
			const botBridgeIdx = horizDashed.findIndex((h) => Math.abs(h.v - vMin) <= 2.5 && Math.abs(h.uMin - u1) <= 2.5 && Math.abs(h.uMax - u2) <= 2.5);
			const topBridgeIdx = horizDashed.findIndex((h) => Math.abs(h.v - vMax) <= 2.5 && Math.abs(h.uMin - u1) <= 2.5 && Math.abs(h.uMax - u2) <= 2.5);
			const hasBotBridge = botBridgeIdx !== -1;
			const hasTopBridge = topBridgeIdx !== -1;
			consumedVertIdx.add(i);
			consumedVertIdx.add(j);
			if (hasTopBridge && !hasBotBridge) {
				consumedHorizIdx.add(topBridgeIdx);
				uSlots.push({
					uMin: u1,
					uMax: u2,
					vMin: botTouchA || botTouchB ? vMin - 2 : vMin,
					vMax,
					openSide: "vMin",
					lineType: "thin_dashed"
				});
			} else if (hasBotBridge && !hasTopBridge) {
				consumedHorizIdx.add(botBridgeIdx);
				uSlots.push({
					uMin: u1,
					uMax: u2,
					vMin,
					vMax: topTouchA || topTouchB ? vMax + 2 : vMax,
					openSide: "vMax",
					lineType: "thin_dashed"
				});
			} else {
				uBands.push({
					u1,
					u2,
					vMin,
					vMax,
					openMin: botTouchA && botTouchB,
					openMax: topTouchA && topTouchB
				});
			}
		} else if (topAligned && hasSlantedBridge({
			u: leftSeg.u,
			v: leftSeg.vMin
		}, {
			u: rightSeg.u,
			v: rightSeg.vMin
		})) {
			consumedVertIdx.add(i);
			consumedVertIdx.add(j);
			const vMax = Math.max(leftSeg.vMax, rightSeg.vMax);
			const padTop = topTouchA || topTouchB || vMax >= viewBounds.vMax - 2.5 ? Math.max(vMax, viewBounds.vMax) + 2 : vMax;
			const poly = [
				{
					u: u1,
					v: leftSeg.vMin
				},
				{
					u: u2,
					v: rightSeg.vMin
				},
				{
					u: u2,
					v: padTop
				},
				{
					u: u1,
					v: padTop
				}
			];
			uBands.push({
				u1,
				u2,
				vMin: Math.min(leftSeg.vMin, rightSeg.vMin),
				vMax: padTop,
				openMin: false,
				openMax: topTouchA || topTouchB,
				slantedPoly: poly
			});
		} else if (botAligned && hasSlantedBridge({
			u: leftSeg.u,
			v: leftSeg.vMax
		}, {
			u: rightSeg.u,
			v: rightSeg.vMax
		})) {
			consumedVertIdx.add(i);
			consumedVertIdx.add(j);
			const vMin = Math.min(leftSeg.vMin, rightSeg.vMin);
			const padBot = botTouchA || botTouchB || vMin <= viewBounds.vMin + 2.5 ? Math.min(vMin, viewBounds.vMin) - 2 : vMin;
			const poly = [
				{
					u: u1,
					v: padBot
				},
				{
					u: u2,
					v: padBot
				},
				{
					u: u2,
					v: rightSeg.vMax
				},
				{
					u: u1,
					v: leftSeg.vMax
				}
			];
			uBands.push({
				u1,
				u2,
				vMin: padBot,
				vMax: Math.max(leftSeg.vMax, rightSeg.vMax),
				openMin: botTouchA || botTouchB,
				openMax: false,
				slantedPoly: poly
			});
		}
	}
	for (let i = 0; i < horizDashed.length; i++) for (let j = i + 1; j < horizDashed.length; j++) {
		const a = horizDashed[i];
		const b = horizDashed[j];
		const botSeg = a.v <= b.v ? a : b;
		const topSeg = a.v <= b.v ? b : a;
		const v1 = botSeg.v;
		const v2 = topSeg.v;
		if (v2 - v1 < 1.5) continue;
		const leftTouchA = isTouchingSolidBoundary({ u: botSeg.uMin, v: botSeg.v }, 2.5);
		const leftTouchB = isTouchingSolidBoundary({ u: topSeg.uMin, v: topSeg.v }, 2.5);
		const rightTouchA = isTouchingSolidBoundary({ u: botSeg.uMax, v: botSeg.v }, 2.5);
		const rightTouchB = isTouchingSolidBoundary({ u: topSeg.uMax, v: topSeg.v }, 2.5);
		const leftAligned = Math.abs(botSeg.uMin - topSeg.uMin) <= 3.5 || leftTouchA && leftTouchB;
		const rightAligned = Math.abs(botSeg.uMax - topSeg.uMax) <= 3.5 || rightTouchA && rightTouchB;
		if (leftAligned && rightAligned) {
			const uMin = Math.min(botSeg.uMin, topSeg.uMin);
			const uMax = Math.max(botSeg.uMax, topSeg.uMax);
			const leftBridgeIdx = vertDashed.findIndex((v) => Math.abs(v.u - uMin) <= 2.5 && Math.abs(v.vMin - v1) <= 2.5 && Math.abs(v.vMax - v2) <= 2.5);
			const rightBridgeIdx = vertDashed.findIndex((v) => Math.abs(v.u - uMax) <= 2.5 && Math.abs(v.vMin - v1) <= 2.5 && Math.abs(v.vMax - v2) <= 2.5);
			const hasLeftBridge = leftBridgeIdx !== -1;
			const hasRightBridge = rightBridgeIdx !== -1;
			consumedHorizIdx.add(i);
			consumedHorizIdx.add(j);
			if (hasRightBridge && !hasLeftBridge) {
				consumedVertIdx.add(rightBridgeIdx);
				uSlots.push({
					uMin: leftTouchA || leftTouchB ? uMin - 2 : uMin,
					uMax,
					vMin: v1,
					vMax: v2,
					openSide: "uMin",
					lineType: "thin_dashed"
				});
			} else if (hasLeftBridge && !hasRightBridge) {
				consumedVertIdx.add(leftBridgeIdx);
				uSlots.push({
					uMin,
					uMax: rightTouchA || rightTouchB ? uMax + 2 : uMax,
					vMin: v1,
					vMax: v2,
					openSide: "uMax",
					lineType: "thin_dashed"
				});
			} else {
				vBands.push({
					v1,
					v2,
					uMin,
					uMax,
					openMin: leftTouchA && leftTouchB,
					openMax: rightTouchA && rightTouchB
				});
			}
		} else if (leftAligned && hasSlantedBridge({
			u: botSeg.uMax,
			v: botSeg.v
		}, {
			u: topSeg.uMax,
			v: topSeg.v
		})) {
			consumedHorizIdx.add(i);
			consumedHorizIdx.add(j);
			const uMin = Math.min(botSeg.uMin, topSeg.uMin);
			const padLeft = leftTouchA || leftTouchB || uMin <= viewBounds.uMin + 2.5 ? Math.min(uMin, viewBounds.uMin) - 2 : uMin;
			vBands.push({
				v1,
				v2,
				uMin: padLeft,
				uMax: Math.max(botSeg.uMax, topSeg.uMax),
				openMin: leftTouchA || leftTouchB,
				openMax: false,
				slantedPoly: [
					{
						u: padLeft,
						v: v1
					},
					{
						u: botSeg.uMax,
						v: v1
					},
					{
						u: topSeg.uMax,
						v: v2
					},
					{
						u: padLeft,
						v: v2
					}
				]
			});
		} else if (rightAligned && hasSlantedBridge({
			u: botSeg.uMin,
			v: botSeg.v
		}, {
			u: topSeg.uMin,
			v: topSeg.v
		})) {
			consumedHorizIdx.add(i);
			consumedHorizIdx.add(j);
			const uMax = Math.max(botSeg.uMax, topSeg.uMax);
			const padRight = rightTouchA || rightTouchB || uMax >= viewBounds.uMax - 2.5 ? Math.max(uMax, viewBounds.uMax) + 2 : uMax;
			vBands.push({
				v1,
				v2,
				uMin: Math.min(botSeg.uMin, topSeg.uMin),
				uMax: padRight,
				openMin: false,
				openMax: rightTouchA || rightTouchB,
				slantedPoly: [
					{
						u: botSeg.uMin,
						v: v1
					},
					{
						u: padRight,
						v: v1
					},
					{
						u: padRight,
						v: v2
					},
					{
						u: topSeg.uMin,
						v: v2
					}
				]
			});
		}
	}
	for (let i = 0; i < rawVertSolid.length; i++) for (let j = i + 1; j < rawVertSolid.length; j++) {
		const a = rawVertSolid[i];
		const b = rawVertSolid[j];
		const u1 = Math.min(a.u, b.u);
		const u2 = Math.max(a.u, b.u);
		if (u2 - u1 >= 2 && Math.abs(a.vMin - b.vMin) <= 3 && Math.abs(a.vMax - b.vMax) <= 3) solidUBands.push({
			u1,
			u2,
			vMin: Math.min(a.vMin, b.vMin),
			vMax: Math.max(a.vMax, b.vMax)
		});
	}
	for (let i = 0; i < rawHorizSolid.length; i++) for (let j = i + 1; j < rawHorizSolid.length; j++) {
		const a = rawHorizSolid[i];
		const b = rawHorizSolid[j];
		const v1 = Math.min(a.v, b.v);
		const v2 = Math.max(a.v, b.v);
		if (v2 - v1 >= 2 && Math.abs(a.uMin - b.uMin) <= 3 && Math.abs(a.uMax - b.uMax) <= 3) solidVBands.push({
			v1,
			v2,
			uMin: Math.min(a.uMin, b.uMin),
			uMax: Math.max(a.uMax, b.uMax)
		});
	}
	return {
		uSlots,
		uBands,
		vBands,
		singleHorizDashed: horizDashed.map(({ v, uMin, uMax }, idx) => ({
			v,
			uMin,
			uMax,
			isStepPlane: !consumedHorizIdx.has(idx) && isTouchingSolidBoundary({ u: uMin, v }, 2.5) && isTouchingSolidBoundary({ u: uMax, v }, 2.5)
		})),
		singleVertDashed: vertDashed.map(({ u, vMin, vMax }, idx) => ({
			u,
			vMin,
			vMax,
			isStepPlane: !consumedVertIdx.has(idx) && isTouchingSolidBoundary({ u, v: vMin }, 2.5) && isTouchingSolidBoundary({ u, v: vMax }, 2.5)
		})),
		solidUBands,
		solidVBands
	};
}
/**
* Automatic 3D Analytical SDF-CSG + Raycast HLR Derivation for Custom User-Drawn Views
* Strictly requires at least 2 views with valid closed contours ("知二求三").
* Supports 100% symmetric (Front+Top->Left, Front+Left->Top, Top+Left->Front) derivation,
* cross-view feature interval pairing, and under-constrained multi-solution generation!
*/
export function deriveFromCustomViews(entities, knownViews, targetView) {
	const userEntities = entities.filter((e) => e.source !== "derived" && e.lineType !== "construction");
	const [v1, v2] = knownViews;
	const stitchedArcIdsFront = new Set<string>();
	const stitchedArcIdsTop = new Set<string>();
	const stitchedArcIdsLeft = new Set<string>();
	const protectedDashedArcIds = new Set<string>();
	const circlesFront = extractNormalizedCirclesInView(userEntities, "front", stitchedArcIdsFront, protectedDashedArcIds);
	const circlesTop = extractNormalizedCirclesInView(userEntities, "top", stitchedArcIdsTop, protectedDashedArcIds);
	const circlesLeft = extractNormalizedCirclesInView(userEntities, "left", stitchedArcIdsLeft, protectedDashedArcIds);
	const solidLoopsFront = extractClosedLoopsInView(userEntities, "front", ["thick_solid"], stitchedArcIdsFront);
	const solidLoopsTop = extractClosedLoopsInView(userEntities, "top", ["thick_solid"], stitchedArcIdsTop);
	const solidLoopsLeft = extractClosedLoopsInView(userEntities, "left", ["thick_solid"], stitchedArcIdsLeft);
	const allLoopsFront = extractClosedLoopsInView(userEntities, "front", ["thick_solid", "thin_dashed"], stitchedArcIdsFront);
	const allLoopsTop = extractClosedLoopsInView(userEntities, "top", ["thick_solid", "thin_dashed"], stitchedArcIdsTop);
	const allLoopsLeft = extractClosedLoopsInView(userEntities, "left", ["thick_solid", "thin_dashed"], stitchedArcIdsLeft);
	const hasValidRegion = (v) => {
		if (v === "front") return solidLoopsFront.length > 0 || circlesFront.length > 0;
		if (v === "top") return solidLoopsTop.length > 0 || circlesTop.length > 0;
		return solidLoopsLeft.length > 0 || circlesLeft.length > 0;
	};
	if (!hasValidRegion(v1) || !hasValidRegion(v2)) return [];
	const expandBoundsWithCircles = (rawB: any, cirList: any[]) => {
		let b = rawB ? { ...rawB } : null;
		for (const c of cirList) {
			if (c.lineType !== "thick_solid") continue;
			const cuMin = c.center.u - c.radius;
			const cuMax = c.center.u + c.radius;
			const cvMin = c.center.v - c.radius;
			const cvMax = c.center.v + c.radius;
			if (!b) b = { uMin: cuMin, uMax: cuMax, vMin: cvMin, vMax: cvMax };
			else {
				b.uMin = Math.min(b.uMin, cuMin);
				b.uMax = Math.max(b.uMax, cuMax);
				b.vMin = Math.min(b.vMin, cvMin);
				b.vMax = Math.max(b.vMax, cvMax);
			}
		}
		return b;
	};
	const bFront = expandBoundsWithCircles(getViewBounds(userEntities, "front"), circlesFront);
	const bTop = expandBoundsWithCircles(getViewBounds(userEntities, "top"), circlesTop);
	const bLeft = expandBoundsWithCircles(getViewBounds(userEntities, "left"), circlesLeft);
	const xSource = bFront || bTop;
	const zSource = bFront || bLeft;
	const yBTop = bTop ? {
		min: bTop.vMin,
		max: bTop.vMax
	} : null;
	const yBLeft = bLeft ? {
		min: bLeft.uMin,
		max: bLeft.uMax
	} : null;
	const ySource = yBTop || yBLeft;
	if (!xSource || !ySource || !zSource) return [];
	const xMin = xSource.uMin;
	const xMax = xSource.uMax;
	const yMin = ySource.min;
	const yMax = ySource.max;
	const zMin = zSource.vMin;
	const zMax = zSource.vMax;
	if (xMax - xMin < 1 || yMax - yMin < 1 || zMax - zMin < 1) return [];
	const bounds = {
		xMin,
		xMax,
		yMin,
		yMax,
		zMin,
		zMax
	};
	const emptySlots = {
		uSlots: [],
		uBands: [],
		vBands: [],
		singleHorizDashed: [],
		singleVertDashed: [],
		solidUBands: [],
		solidVBands: []
	};
	const slotsFront = bFront ? extractOpenSlotsAndDashedBandsInView(userEntities, "front", bFront) : emptySlots;
	const slotsTop = bTop ? extractOpenSlotsAndDashedBandsInView(userEntities, "top", bTop) : emptySlots;
	const slotsLeft = bLeft ? extractOpenSlotsAndDashedBandsInView(userEntities, "left", bLeft) : emptySlots;
	const basePrimitives = [];
	const usedEntityIds = new Set<string>(protectedDashedArcIds);
	const markCircleUsed = (c: any) => {
		if (!c) return;
		if (c.id) usedEntityIds.add(c.id);
		if (Array.isArray(c.sourceIds)) {
			for (const sid of c.sourceIds) usedEntityIds.add(sid);
		}
	};
	const pairedSubtracts = [];
	const getOuterCircleInView = (v) => {
		const circles = v === "front" ? circlesFront : v === "top" ? circlesTop : circlesLeft;
		const vB = v === "front" ? bFront : v === "top" ? bTop : bLeft;
		if (!vB) return void 0;
		return circles.find((c) => c.lineType === "thick_solid" && Math.abs(c.radius * 2 - (vB.uMax - vB.uMin)) <= 3 && Math.abs(c.radius * 2 - (vB.vMax - vB.vMin)) <= 3);
	};
	const cir1 = getOuterCircleInView(v1);
	const cir2 = getOuterCircleInView(v2);
	if (cir1 && cir2 && Math.abs(cir1.radius - cir2.radius) <= 2.5) {
		const R = .5 * (cir1.radius + cir2.radius);
		let sx = .5 * (xMin + xMax);
		let sy = .5 * (yMin + yMax);
		let sz = .5 * (zMin + zMax);
		let aligned = false;
		if (v1 === "front" && v2 === "top" || v1 === "top" && v2 === "front") {
			const cf = v1 === "front" ? cir1 : cir2;
			const ct = v1 === "top" ? cir1 : cir2;
			if (Math.abs(cf.center.u - ct.center.u) <= 2.5) {
				aligned = true;
				sx = .5 * (cf.center.u + ct.center.u);
				sy = ct.center.v;
				sz = cf.center.v;
			}
		} else if (v1 === "front" && v2 === "left" || v1 === "left" && v2 === "front") {
			const cf = v1 === "front" ? cir1 : cir2;
			const cl = v1 === "left" ? cir1 : cir2;
			if (Math.abs(cf.center.v - cl.center.v) <= 2.5) {
				aligned = true;
				sx = cf.center.u;
				sy = cl.center.u;
				sz = .5 * (cf.center.v + cl.center.v);
			}
		} else if (v1 === "top" && v2 === "left" || v1 === "left" && v2 === "top") {
			const ct = v1 === "top" ? cir1 : cir2;
			const cl = v1 === "left" ? cir1 : cir2;
			if (Math.abs(ct.center.v - cl.center.u) <= 2.5) {
				aligned = true;
				sx = ct.center.u;
				sy = .5 * (ct.center.v + cl.center.u);
				sz = cl.center.v;
			}
		}
		if (aligned) {
			markCircleUsed(cir1);
			markCircleUsed(cir2);
			basePrimitives.push({
				id: "base-sphere",
				featureId: "custom_main",
				label: `Sphere SR${Math.round(R)}`,
				operation: "add",
				shape: "sphere",
				xMin: sx - R,
				xMax: sx + R,
				yMin: sy - R,
				yMax: sy + R,
				zMin: sz - R,
				zMax: sz + R,
				centerX: sx,
				centerY: sy,
				centerZ: sz,
				radius: R
			});
			const cList1 = (v1 === "front" ? circlesFront : v1 === "top" ? circlesTop : circlesLeft).filter((c) => c.id !== cir1.id && dist2D(c.center, cir1.center) <= 2);
			const cList2 = (v2 === "front" ? circlesFront : v2 === "top" ? circlesTop : circlesLeft).filter((c) => c.id !== cir2.id && dist2D(c.center, cir2.center) <= 2);
			for (const ic1 of cList1) {
				const ic2 = cList2.find((c) => Math.abs(c.radius - ic1.radius) <= 2);
				if (ic2) {
					markCircleUsed(ic1);
					markCircleUsed(ic2);
					const rIn = .5 * (ic1.radius + ic2.radius);
					pairedSubtracts.push({
						id: `sub-sphere-cavity-${pairedSubtracts.length}`,
						featureId: "sphere_cavity",
						label: `Spherical Cavity SR${Math.round(rIn)}`,
						operation: "subtract",
						shape: "sphere",
						xMin: sx - rIn,
						xMax: sx + rIn,
						yMin: sy - rIn,
						yMax: sy + rIn,
						zMin: sz - rIn,
						zMax: sz + rIn,
						centerX: sx,
						centerY: sy,
						centerZ: sz,
						radius: rIn,
						isInternalFeature: true
					});
				}
			}
		}
	}
	const analyzeLoopProfile = (lp: any): any => {
		const arcSegs = lp.segments.filter((s) => s.kind === "arc");
		const lineSegs = lp.segments.filter((s) => s.kind === "line");
		if (arcSegs.length === 1 && lineSegs.length === 1 && arcSegs[0].center && arcSegs[0].radius) {
			const arc = arcSegs[0];
			const ln = lineSegs[0];
			const dv = Math.abs(ln.p1.v - ln.p2.v);
			const du = Math.abs(ln.p1.u - ln.p2.u);
			if (dv <= 3.0 && du > 3.0) {
				const rawV = 0.5 * (ln.p1.v + ln.p2.v);
				const vFlat = Math.abs(rawV - arc.center.v) <= 3.5 ? arc.center.v : rawV;
				ln.p1 = { u: ln.p1.u, v: vFlat };
				ln.p2 = { u: ln.p2.u, v: vFlat };
				if (Math.abs(lp.vMin - rawV) <= 3.5) lp.vMin = vFlat;
				if (Math.abs(lp.vMax - rawV) <= 3.5) lp.vMax = vFlat;
				return {
					kind: "semicircle",
					orientation: "h",
					center: { u: arc.center.u, v: vFlat },
					radius: arc.radius,
					vFlat
				};
			}
			if (du <= 3.0 && dv > 3.0) {
				const rawU = 0.5 * (ln.p1.u + ln.p2.u);
				const uFlat = Math.abs(rawU - arc.center.u) <= 3.5 ? arc.center.u : rawU;
				ln.p1 = { u: uFlat, v: ln.p1.v };
				ln.p2 = { u: uFlat, v: ln.p2.v };
				if (Math.abs(lp.uMin - rawU) <= 3.5) lp.uMin = uFlat;
				if (Math.abs(lp.uMax - rawU) <= 3.5) lp.uMax = uFlat;
				return {
					kind: "semicircle",
					orientation: "v",
					center: { u: uFlat, v: arc.center.v },
					radius: arc.radius,
					uFlat
				};
			}
			return {
				kind: "tilted_arc_loop",
				center: arc.center,
				radius: arc.radius
			};
		}
		if (arcSegs.length === 0 && lineSegs.length === 3) {
			const verts = lineSegs.map((s) => s.p1);
			for (let i = 0; i < 3; i++) {
				const a = verts[i];
				const b = verts[(i + 1) % 3];
				const apex = verts[(i + 2) % 3];
				if (Math.abs(a.v - b.v) <= 2.5) return {
					kind: "triangle_h",
					apex,
					baseV: .5 * (a.v + b.v),
					baseUMin: Math.min(a.u, b.u),
					baseUMax: Math.max(a.u, b.u)
				};
				if (Math.abs(a.u - b.u) <= 2.5) return {
					kind: "triangle_v",
					apex,
					baseU: .5 * (a.u + b.u),
					baseVMin: Math.min(a.v, b.v),
					baseVMax: Math.max(a.v, b.v)
				};
			}
		}
		if (arcSegs.length === 0 && lineSegs.length === 4) {
			const horiz = lineSegs.filter((s) => Math.abs(s.p1.v - s.p2.v) <= 1.5);
			if (horiz.length === 2) {
				const w1 = Math.abs(horiz[0].p2.u - horiz[0].p1.u);
				const w2 = Math.abs(horiz[1].p2.u - horiz[1].p1.u);
				if (Math.abs(w1 - w2) > 2) {
					const vA = .5 * (horiz[0].p1.v + horiz[0].p2.v);
					const vB = .5 * (horiz[1].p1.v + horiz[1].p2.v);
					const hMin = vA < vB ? horiz[0] : horiz[1];
					const hMax = vA < vB ? horiz[1] : horiz[0];
					const uMinAtVMin = Math.min(hMin.p1.u, hMin.p2.u);
					const uMaxAtVMin = Math.max(hMin.p1.u, hMin.p2.u);
					const uMinAtVMax = Math.min(hMax.p1.u, hMax.p2.u);
					const uMaxAtVMax = Math.max(hMax.p1.u, hMax.p2.u);
					return {
						kind: "trapezoid_h",
						rAtVMin: .5 * (uMaxAtVMin - uMinAtVMin),
						rAtVMax: .5 * (uMaxAtVMax - uMinAtVMax),
						uMinAtVMin,
						uMaxAtVMin,
						uMinAtVMax,
						uMaxAtVMax,
						cAtVMin: .5 * (uMinAtVMin + uMaxAtVMin),
						cAtVMax: .5 * (uMinAtVMax + uMaxAtVMax),
						wSlopeMin: Math.min(vA, vB),
						wSlopeMax: Math.max(vA, vB)
					};
				}
			}
			const vert = lineSegs.filter((s) => Math.abs(s.p1.u - s.p2.u) <= 1.5);
			if (vert.length === 2) {
				const h1 = Math.abs(vert[0].p2.v - vert[0].p1.v);
				const h2 = Math.abs(vert[1].p2.v - vert[1].p1.v);
				if (Math.abs(h1 - h2) > 2) {
					const uA = .5 * (vert[0].p1.u + vert[0].p2.u);
					const uB = .5 * (vert[1].p1.u + vert[1].p2.u);
					const vMinSeg = uA < uB ? vert[0] : vert[1];
					const vMaxSeg = uA < uB ? vert[1] : vert[0];
					const vMinAtUMin = Math.min(vMinSeg.p1.v, vMinSeg.p2.v);
					const vMaxAtUMin = Math.max(vMinSeg.p1.v, vMinSeg.p2.v);
					const vMinAtUMax = Math.min(vMaxSeg.p1.v, vMaxSeg.p2.v);
					const vMaxAtUMax = Math.max(vMaxSeg.p1.v, vMaxSeg.p2.v);
					return {
						kind: "trapezoid_v",
						rAtUMin: .5 * (vMaxAtUMin - vMinAtUMin),
						rAtUMax: .5 * (vMaxAtUMax - vMinAtUMax),
						vMinAtUMin,
						vMaxAtUMin,
						vMinAtUMax,
						vMaxAtUMax,
						cAtUMin: .5 * (vMinAtUMin + vMaxAtUMin),
						cAtUMax: .5 * (vMinAtUMax + vMaxAtUMax),
						wSlopeMin: Math.min(uA, uB),
						wSlopeMax: Math.max(uA, uB)
					};
				}
			}
		}
		if (lineSegs.length >= 2) {
			const vSlanted = lineSegs.filter((s) => Math.abs(s.p2.v - s.p1.v) > 4 && Math.abs(s.p2.u - s.p1.u) > 1);
			if (vSlanted.length >= 2) {
				for (let i = 0; i < vSlanted.length; i++) for (let j = i + 1; j < vSlanted.length; j++) {
					const sA = vSlanted[i];
					const sB = vSlanted[j];
					const aMinPt = sA.p1.v <= sA.p2.v ? sA.p1 : sA.p2;
					const aMaxPt = sA.p1.v <= sA.p2.v ? sA.p2 : sA.p1;
					const bMinPt = sB.p1.v <= sB.p2.v ? sB.p1 : sB.p2;
					const bMaxPt = sB.p1.v <= sB.p2.v ? sB.p2 : sB.p1;
					if (Math.abs(aMinPt.v - bMinPt.v) <= 2.5 && Math.abs(aMaxPt.v - bMaxPt.v) <= 2.5) {
						const spanMin = Math.abs(bMinPt.u - aMinPt.u);
						const spanMax = Math.abs(bMaxPt.u - aMaxPt.u);
						if (Math.abs(spanMax - spanMin) > 2) return {
							kind: "trapezoid_h",
							rAtVMin: .5 * spanMin,
							rAtVMax: .5 * spanMax,
							uMinAtVMin: Math.min(aMinPt.u, bMinPt.u),
							uMaxAtVMin: Math.max(aMinPt.u, bMinPt.u),
							uMinAtVMax: Math.min(aMaxPt.u, bMaxPt.u),
							uMaxAtVMax: Math.max(aMaxPt.u, bMaxPt.u),
							cAtVMin: .5 * (aMinPt.u + bMinPt.u),
							cAtVMax: .5 * (aMaxPt.u + bMaxPt.u),
							wSlopeMin: .5 * (aMinPt.v + bMinPt.v),
							wSlopeMax: .5 * (aMaxPt.v + bMaxPt.v),
							notchedArcs: arcSegs
						};
					}
				}
			}
			const uSlanted = lineSegs.filter((s) => Math.abs(s.p2.u - s.p1.u) > 4 && Math.abs(s.p2.v - s.p1.v) > 1);
			if (uSlanted.length >= 2) {
				for (let i = 0; i < uSlanted.length; i++) for (let j = i + 1; j < uSlanted.length; j++) {
					const sA = uSlanted[i];
					const sB = uSlanted[j];
					const aMinPt = sA.p1.u <= sA.p2.u ? sA.p1 : sA.p2;
					const aMaxPt = sA.p1.u <= sA.p2.u ? sA.p2 : sA.p1;
					const bMinPt = sB.p1.u <= sB.p2.u ? sB.p1 : sB.p2;
					const bMaxPt = sB.p1.u <= sB.p2.u ? sB.p2 : sB.p1;
					if (Math.abs(aMinPt.u - bMinPt.u) <= 2.5 && Math.abs(aMaxPt.u - bMaxPt.u) <= 2.5) {
						const spanMin = Math.abs(bMinPt.v - aMinPt.v);
						const spanMax = Math.abs(bMaxPt.v - aMaxPt.v);
						if (Math.abs(spanMax - spanMin) > 2) return {
							kind: "trapezoid_v",
							rAtUMin: .5 * spanMin,
							rAtUMax: .5 * spanMax,
							vMinAtUMin: Math.min(aMinPt.v, bMinPt.v),
							vMaxAtUMin: Math.max(aMinPt.v, bMinPt.v),
							vMinAtUMax: Math.min(aMaxPt.v, bMaxPt.v),
							vMaxAtUMax: Math.max(aMaxPt.v, bMaxPt.v),
							cAtUMin: .5 * (aMinPt.v + bMinPt.v),
							cAtUMax: .5 * (aMaxPt.v + bMaxPt.v),
							wSlopeMin: .5 * (aMinPt.u + bMinPt.u),
							wSlopeMax: .5 * (aMaxPt.u + bMaxPt.u),
							notchedArcs: arcSegs
						};
					}
				}
			}
		}
		return { kind: "general" };
	};
	const detectSlantedProfileFromRawEntities = (view: any): any => {
		const rawSegs = userEntities.filter((e) => e.view === view && e.lineType === "thick_solid" && (e.type === "line" || e.type === "polygon")).flatMap((e) => expandEntityToSegments(e));
		const rawArcs = userEntities.filter((e) => e.view === view && e.lineType === "thick_solid" && e.type === "arc");
		const vSlanted = rawSegs.filter((s) => Math.abs(s.p2.v - s.p1.v) > 4 && Math.abs(s.p2.u - s.p1.u) > 1);
		for (let i = 0; i < vSlanted.length; i++) for (let j = i + 1; j < vSlanted.length; j++) {
			const sA = vSlanted[i];
			const sB = vSlanted[j];
			const aMinPt = sA.p1.v <= sA.p2.v ? sA.p1 : sA.p2;
			const aMaxPt = sA.p1.v <= sA.p2.v ? sA.p2 : sA.p1;
			const bMinPt = sB.p1.v <= sB.p2.v ? sB.p1 : sB.p2;
			const bMaxPt = sB.p1.v <= sB.p2.v ? sB.p2 : sB.p1;
			if (Math.abs(aMinPt.v - bMinPt.v) <= 2.5 && Math.abs(aMaxPt.v - bMaxPt.v) <= 2.5) {
				const spanMin = Math.abs(bMinPt.u - aMinPt.u);
				const spanMax = Math.abs(bMaxPt.u - aMaxPt.u);
				if (spanMin <= 2.0 && spanMax > 4) return {
					kind: "triangle_h",
					apex: { u: .5 * (aMinPt.u + bMinPt.u), v: .5 * (aMinPt.v + bMinPt.v) },
					baseV: .5 * (aMaxPt.v + bMaxPt.v),
					baseUMin: Math.min(aMaxPt.u, bMaxPt.u),
					baseUMax: Math.max(aMaxPt.u, bMaxPt.u)
				};
				if (spanMax <= 2.0 && spanMin > 4) return {
					kind: "triangle_h",
					apex: { u: .5 * (aMaxPt.u + bMaxPt.u), v: .5 * (aMaxPt.v + bMaxPt.v) },
					baseV: .5 * (aMinPt.v + bMinPt.v),
					baseUMin: Math.min(aMinPt.u, bMinPt.u),
					baseUMax: Math.max(aMinPt.u, bMinPt.u)
				};
				if (Math.abs(spanMax - spanMin) > 2) return {
					kind: "trapezoid_h",
					rAtVMin: .5 * spanMin,
					rAtVMax: .5 * spanMax,
					uMinAtVMin: Math.min(aMinPt.u, bMinPt.u),
					uMaxAtVMin: Math.max(aMinPt.u, bMinPt.u),
					uMinAtVMax: Math.min(aMaxPt.u, bMaxPt.u),
					uMaxAtVMax: Math.max(aMaxPt.u, bMaxPt.u),
					cAtVMin: .5 * (aMinPt.u + bMinPt.u),
					cAtVMax: .5 * (aMaxPt.u + bMaxPt.u),
					wSlopeMin: .5 * (aMinPt.v + bMinPt.v),
					wSlopeMax: .5 * (aMaxPt.v + bMaxPt.v),
					notchedArcs: rawArcs
				};
			}
		}
		const uSlanted = rawSegs.filter((s) => Math.abs(s.p2.u - s.p1.u) > 4 && Math.abs(s.p2.v - s.p1.v) > 1);
		for (let i = 0; i < uSlanted.length; i++) for (let j = i + 1; j < uSlanted.length; j++) {
			const sA = uSlanted[i];
			const sB = uSlanted[j];
			const aMinPt = sA.p1.u <= sA.p2.u ? sA.p1 : sA.p2;
			const aMaxPt = sA.p1.u <= sA.p2.u ? sA.p2 : sA.p1;
			const bMinPt = sB.p1.u <= sB.p2.u ? sB.p1 : sB.p2;
			const bMaxPt = sB.p1.u <= sB.p2.u ? sB.p2 : sB.p1;
			if (Math.abs(aMinPt.u - bMinPt.u) <= 2.5 && Math.abs(aMaxPt.u - bMaxPt.u) <= 2.5) {
				const spanMin = Math.abs(bMinPt.v - aMinPt.v);
				const spanMax = Math.abs(bMaxPt.v - aMaxPt.v);
				if (spanMin <= 2.0 && spanMax > 4) return {
					kind: "triangle_v",
					apex: { u: .5 * (aMinPt.u + bMinPt.u), v: .5 * (aMinPt.v + bMinPt.v) },
					baseU: .5 * (aMaxPt.u + bMaxPt.u),
					baseVMin: Math.min(aMaxPt.v, bMaxPt.v),
					baseVMax: Math.max(aMaxPt.v, bMaxPt.v)
				};
				if (spanMax <= 2.0 && spanMin > 4) return {
					kind: "triangle_v",
					apex: { u: .5 * (aMaxPt.u + bMaxPt.u), v: .5 * (aMaxPt.v + bMaxPt.v) },
					baseU: .5 * (aMinPt.u + bMinPt.u),
					baseVMin: Math.min(aMinPt.v, bMinPt.v),
					baseVMax: Math.max(aMinPt.v, bMinPt.v)
				};
				if (Math.abs(spanMax - spanMin) > 2) return {
					kind: "trapezoid_v",
					rAtUMin: .5 * spanMin,
					rAtUMax: .5 * spanMax,
					vMinAtUMin: Math.min(aMinPt.v, bMinPt.v),
					vMaxAtUMin: Math.max(aMinPt.v, bMinPt.v),
					vMinAtUMax: Math.min(aMaxPt.v, bMaxPt.v),
					vMaxAtUMax: Math.max(aMaxPt.v, bMaxPt.v),
					cAtUMin: .5 * (aMinPt.v + bMinPt.v),
					cAtUMax: .5 * (aMaxPt.v + bMaxPt.v),
					wSlopeMin: .5 * (aMinPt.u + bMinPt.u),
					wSlopeMax: .5 * (aMaxPt.u + bMaxPt.u),
					notchedArcs: rawArcs
				};
			}
		}
		return null;
	};
	// ============================================================================
	// Stage 3: Universal Sub-Feature Orthogonal Pairing Matrix
	// Pairs all independent sub-features (VirtualCircles, Semicircles, Triangles,
	// Trapezoids, Rectangles, Polygons) between v1 and v2 when their shared-axis
	// spans align within 2.5mm, generating additive 3D primitives.
	// ============================================================================
	if (basePrimitives.length === 0) {
		const buildSubFeaturesForView = (v: "front" | "top" | "left") => {
			const rawCircles = (v === "front" ? circlesFront : v === "top" ? circlesTop : circlesLeft)
				.filter((c) => c.lineType === "thick_solid")
				.sort((a, b) => b.radius - a.radius);
			const rawLoops = v === "front" ? solidLoopsFront : v === "top" ? solidLoopsTop : solidLoopsLeft;

			const circleClusters: any[] = [];
			for (const c of rawCircles) {
				const parentCluster = circleClusters.find(
					(cl) => dist2D(cl.outer.center, c.center) + c.radius <= cl.outer.radius + 2.5 && c.radius < cl.outer.radius - 0.5
				);
				if (parentCluster) {
					parentCluster.inners.push(c);
				} else {
					circleClusters.push({
						featureType: "circle",
						outer: c,
						inners: [],
						uMin: c.center.u - c.radius,
						uMax: c.center.u + c.radius,
						vMin: c.center.v - c.radius,
						vMax: c.center.v + c.radius
					});
				}
			}

			const hasDecomposed = rawLoops.some((lp: any) => lp.isDecomposedSubLoop);
			const candidateLoops = hasDecomposed
				? rawLoops.filter((lp: any, idx: number) => idx > 0 || lp.isDecomposedSubLoop)
				: rawLoops;

			const loopFeatures = candidateLoops.map((lp: any) => ({
				featureType: "loop",
				loop: lp,
				profile: analyzeLoopProfile(lp),
				uMin: lp.uMin,
				uMax: lp.uMax,
				vMin: lp.vMin,
				vMax: lp.vMax
			}));

			return [...circleClusters, ...loopFeatures];
		};

		const getSharedSpan = (feat: any, view: "front" | "top" | "left", otherView: "front" | "top" | "left") => {
			if ((view === "front" && otherView === "top") || (view === "top" && otherView === "front")) {
				return { min: feat.uMin, max: feat.uMax };
			}
			if ((view === "front" && otherView === "left") || (view === "left" && otherView === "front")) {
				return { min: feat.vMin, max: feat.vMax };
			}
			if (view === "top" && otherView === "left") {
				return { min: feat.vMin, max: feat.vMax };
			}
			return { min: feat.uMin, max: feat.uMax };
		};

		const isAxisAlignedRectLoop = (lp: any) =>
			!lp.segments.some((s: any) => s.kind === "arc") &&
			lp.points.length === 4 &&
			Math.abs(lp.area - (lp.uMax - lp.uMin) * (lp.vMax - lp.vMin)) <= 2.5;

		const isConeOrTrapProfile = (p: any) =>
			p?.kind === "triangle_h" || p?.kind === "triangle_v" || p?.kind === "trapezoid_h" || p?.kind === "trapezoid_v";

		const feats1 = buildSubFeaturesForView(v1);
		const feats2 = buildSubFeaturesForView(v2);

		// Run Universal Sub-Feature Pairing Matrix whenever there are multiple sub-features across the two views
		if (feats1.length + feats2.length >= 3) {
			const pairedAddPrims: Primitive3D[] = [];
			const pairSubFeatures = (f1: any, f2: any): Primitive3D | null => {
				const s1 = getSharedSpan(f1, v1, v2);
				const s2 = getSharedSpan(f2, v2, v1);
				if (Math.abs(s1.min - s2.min) > 2.5 || Math.abs(s1.max - s2.max) > 2.5) return null;

				// 1. Circle x Circle -> Sphere
				if (f1.featureType === "circle" && f2.featureType === "circle") {
					const c1 = f1.outer;
					const c2 = f2.outer;
					if (Math.abs(c1.radius - c2.radius) <= 2.5) {
						markCircleUsed(c1);
						markCircleUsed(c2);
						const R = 0.5 * (c1.radius + c2.radius);
						const sx = v1 === "front" || v1 === "top" ? c1.center.u : c2.center.u;
						const sy = v1 === "top" ? c1.center.v : v1 === "left" ? c1.center.u : v2 === "top" ? c2.center.v : c2.center.u;
						const sz = v1 === "front" || v1 === "left" ? c1.center.v : c2.center.v;
						return {
							id: `subfeat-sphere-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Sphere SR${Math.round(R)}`,
							operation: "add",
							shape: "sphere",
							xMin: sx - R,
							xMax: sx + R,
							yMin: sy - R,
							yMax: sy + R,
							zMin: sz - R,
							zMax: sz + R,
							centerX: sx,
							centerY: sy,
							centerZ: sz,
							radius: R
						};
					}
				}

				// 2. Circle x Semicircle (or Semicircle x Semicircle) -> Hemisphere
				const isF1Semi = f1.featureType === "loop" && f1.profile?.kind === "semicircle";
				const isF2Semi = f2.featureType === "loop" && f2.profile?.kind === "semicircle";
				if ((isF1Semi && (f2.featureType === "circle" || isF2Semi)) || (isF2Semi && (f1.featureType === "circle" || isF1Semi))) {
					const semiFeat = isF1Semi ? f1 : f2;
					const semiView = isF1Semi ? v1 : v2;
					const otherFeat = isF1Semi ? f2 : f1;
					const otherView = isF1Semi ? v2 : v1;
					const semiProf = semiFeat.profile;
					const semiLp = semiFeat.loop;
					if (otherFeat.featureType === "circle") markCircleUsed(otherFeat.outer);
					const R = semiProf.radius;
					const otherCir = otherFeat.featureType === "circle" ? otherFeat.outer : null;
					const otherProf = otherFeat.featureType === "loop" ? otherFeat.profile : null;

					if (semiView === "top") {
						const sx = semiProf.uFlat ?? semiProf.center.u;
						const sy = semiProf.vFlat ?? semiProf.center.v;
						const sz = otherCir ? otherCir.center.v : (otherProf?.center?.v ?? 0.5 * (zMin + zMax));
						const hxMin = Math.min(semiLp.uMin, sx);
						const hxMax = Math.max(semiLp.uMax, sx);
						const hyMin = Math.min(semiLp.vMin, sy);
						const hyMax = Math.max(semiLp.vMax, sy);
						const hzMin = otherCir ? sz - R : otherFeat.vMin;
						const hzMax = otherCir ? sz + R : otherFeat.vMax;
						return {
							id: `subfeat-hemi-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Hemisphere SR${Math.round(R)}`,
							operation: "add",
							shape: "hemisphere",
							xMin: hxMin,
							xMax: hxMax,
							yMin: hyMin,
							yMax: hyMax,
							zMin: hzMin,
							zMax: hzMax,
							centerX: sx,
							centerY: sy,
							centerZ: sz,
							radius: R
						};
					} else if (semiView === "front") {
						const sx = semiProf.uFlat ?? semiProf.center.u;
						const sz = semiProf.vFlat ?? semiProf.center.v;
						const sy = otherView === "top"
							? (otherCir ? otherCir.center.v : (otherProf?.center?.v ?? 0.5 * (yMin + yMax)))
							: (otherCir ? otherCir.center.u : (otherProf?.center?.u ?? 0.5 * (yMin + yMax)));
						const hxMin = Math.min(semiLp.uMin, sx);
						const hxMax = Math.max(semiLp.uMax, sx);
						const hyMin = otherCir ? sy - R : (otherView === "top" ? otherFeat.vMin : otherFeat.uMin);
						const hyMax = otherCir ? sy + R : (otherView === "top" ? otherFeat.vMax : otherFeat.uMax);
						const hzMin = Math.min(semiLp.vMin, sz);
						const hzMax = Math.max(semiLp.vMax, sz);
						return {
							id: `subfeat-hemi-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Hemisphere SR${Math.round(R)}`,
							operation: "add",
							shape: "hemisphere",
							xMin: hxMin,
							xMax: hxMax,
							yMin: hyMin,
							yMax: hyMax,
							zMin: hzMin,
							zMax: hzMax,
							centerX: sx,
							centerY: sy,
							centerZ: sz,
							radius: R
						};
					} else {
						const sy = semiProf.uFlat ?? semiProf.center.u;
						const sz = semiProf.vFlat ?? semiProf.center.v;
						const sx = otherCir ? otherCir.center.u : (otherProf?.center?.u ?? 0.5 * (xMin + xMax));
						const hxMin = otherCir ? sx - R : otherFeat.uMin;
						const hxMax = otherCir ? sx + R : otherFeat.uMax;
						const hyMin = Math.min(semiLp.uMin, sy);
						const hyMax = Math.max(semiLp.uMax, sy);
						const hzMin = Math.min(semiLp.vMin, sz);
						const hzMax = Math.max(semiLp.vMax, sz);
						return {
							id: `subfeat-hemi-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Hemisphere SR${Math.round(R)}`,
							operation: "add",
							shape: "hemisphere",
							xMin: hxMin,
							xMax: hxMax,
							yMin: hyMin,
							yMax: hyMax,
							zMin: hzMin,
							zMax: hzMax,
							centerX: sx,
							centerY: sy,
							centerZ: sz,
							radius: R
						};
					}
				}

				// 3 & 4. CircleCluster x Triangle/Trapezoid -> Cone / Frustum (cone_x / cone_y / cone_z)
				const isF1ConeProf = f1.featureType === "loop" && isConeOrTrapProfile(f1.profile);
				const isF2ConeProf = f2.featureType === "loop" && isConeOrTrapProfile(f2.profile);
				if ((f1.featureType === "circle" && isF2ConeProf) || (f2.featureType === "circle" && isF1ConeProf)) {
					const cirFeat = f1.featureType === "circle" ? f1 : f2;
					const cView = f1.featureType === "circle" ? v1 : v2;
					const profFeat = f1.featureType === "circle" ? f2 : f1;
					const pView = f1.featureType === "circle" ? v2 : v1;
					const cir = cirFeat.outer;
					const prof = profFeat.profile;
					const pLp = profFeat.loop;
					markCircleUsed(cir);

					let rMin = 0;
					let rMax = 0;
					let uCenterMin = cir.center.u;
					let vCenterMin = cir.center.v;
					let uCenterMax = cir.center.u;
					let vCenterMax = cir.center.v;
					const pSlots = pView === "top" ? slotsTop : pView === "front" ? slotsFront : slotsLeft;
					const hasMatchingHoleDashed = (ic: any) => {
						const sharedCoord = cView === "front" && pView === "top" ? ic.center.u : cView === "front" && pView === "left" ? ic.center.v : cView === "top" && pView === "front" ? ic.center.u : cView === "top" && pView === "left" ? ic.center.v : cView === "left" && pView === "front" ? ic.center.v : ic.center.u;
						const s1 = sharedCoord - ic.radius;
						const s2 = sharedCoord + ic.radius;
						const checkU = cView === "front" && pView === "top" || cView === "top" && pView === "front" || cView === "top" && pView === "left";
						if (checkU) {
							return pSlots.uBands.some((b) => Math.abs(b.u1 - s1) <= 2.5 && Math.abs(b.u2 - s2) <= 2.5) || pSlots.uSlots.some((s) => Math.abs(s.uMin - s1) <= 2.5 && Math.abs(s.uMax - s2) <= 2.5);
						}
						return pSlots.vBands.some((b) => Math.abs(b.v1 - s1) <= 2.5 && Math.abs(b.v2 - s2) <= 2.5) || pSlots.uSlots.some((s) => Math.abs(s.vMin - s1) <= 2.5 && Math.abs(s.vMax - s2) <= 2.5);
					};

					if (prof.kind === "triangle_h") {
						rMin = prof.apex.v > prof.baseV ? cir.radius : 0;
						rMax = prof.apex.v > prof.baseV ? 0 : cir.radius;
						if (prof.apex.v > prof.baseV && prof.apex.u !== void 0 && (cView === "top" && pView === "front" || cView === "front" && pView === "top")) uCenterMax = prof.apex.u;
						if (prof.apex.v <= prof.baseV && prof.apex.u !== void 0 && (cView === "top" && pView === "front" || cView === "front" && pView === "top")) uCenterMin = prof.apex.u;
					} else if (prof.kind === "triangle_v") {
						rMin = prof.apex.u > prof.baseU ? cir.radius : 0;
						rMax = prof.apex.u > prof.baseU ? 0 : cir.radius;
					} else {
						const rawRMin = prof.kind === "trapezoid_h" ? prof.rAtVMin : prof.rAtUMin;
						const rawRMax = prof.kind === "trapezoid_h" ? prof.rAtVMax : prof.rAtUMax;
						const cAtMin = prof.kind === "trapezoid_h" ? prof.cAtVMin : prof.cAtUMin;
						const cAtMax = prof.kind === "trapezoid_h" ? prof.cAtVMax : prof.cAtUMax;
						const matchesInnerSpan = (ic: any, targetR: number, targetC?: number) => {
							if (Math.abs(ic.radius - targetR) > 3.0) return false;
							if (targetC === void 0) return true;
							const sharedC = cView === "front" && pView === "top" ? ic.center.u : cView === "front" && pView === "left" ? ic.center.v : cView === "top" && pView === "front" ? ic.center.u : cView === "top" && pView === "left" ? ic.center.v : cView === "left" && pView === "front" ? ic.center.v : ic.center.u;
							return Math.abs(sharedC - targetC) <= 3.0;
						};
						const matchMinInner = cirFeat.inners.find((ic: any) => matchesInnerSpan(ic, rawRMin, cAtMin));
						const matchMaxInner = cirFeat.inners.find((ic: any) => matchesInnerSpan(ic, rawRMax, cAtMax));
						if (rawRMin <= rawRMax) {
							rMin = matchMinInner ? matchMinInner.radius : rawRMin;
							rMax = Math.abs(cir.radius - rawRMax) <= 3.0 ? cir.radius : rawRMax;
							if (matchMinInner) {
								uCenterMin = matchMinInner.center.u;
								vCenterMin = matchMinInner.center.v;
							} else if (cAtMin !== void 0) {
								if (cView === "top" && pView === "front" || cView === "front" && pView === "top") uCenterMin = cAtMin;
								else if (cView === "top" && pView === "left") vCenterMin = cAtMin;
								else if (cView === "front" && pView === "left" || cView === "left" && pView === "front") vCenterMin = cAtMin;
								else if (cView === "left" && pView === "top") uCenterMin = cAtMin;
							}
						} else {
							rMin = Math.abs(cir.radius - rawRMin) <= 3.0 ? cir.radius : rawRMin;
							rMax = matchMaxInner ? matchMaxInner.radius : rawRMax;
							if (matchMaxInner) {
								uCenterMax = matchMaxInner.center.u;
								vCenterMax = matchMaxInner.center.v;
							} else if (cAtMax !== void 0) {
								if (cView === "top" && pView === "front" || cView === "front" && pView === "top") uCenterMax = cAtMax;
								else if (cView === "top" && pView === "left") vCenterMax = cAtMax;
								else if (cView === "front" && pView === "left" || cView === "left" && pView === "front") vCenterMax = cAtMax;
								else if (cView === "left" && pView === "top") uCenterMax = cAtMax;
							}
						}
						for (const ic of cirFeat.inners) {
							if ((Math.abs(ic.radius - rMin) <= 3.0 || Math.abs(ic.radius - rMax) <= 3.0) && !hasMatchingHoleDashed(ic)) {
								markCircleUsed(ic);
							}
						}
					}

					if (cView === "top") {
						const cZMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : pLp.vMin;
						const cZMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : pLp.vMax;
						return {
							id: `subfeat-cone-z-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
							operation: "add",
							shape: "cone_z",
							xMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
							xMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
							yMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
							yMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
							zMin: cZMin,
							zMax: cZMax,
							centerX: cir.center.u,
							centerY: cir.center.v,
							uCenterMin,
							vCenterMin,
							uCenterMax,
							vCenterMax,
							radius: cir.radius,
							rMin,
							rMax
						} as any;
					} else if (cView === "front") {
						const cYMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : (pView === "top" ? pLp.vMin : pLp.uMin);
						const cYMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : (pView === "top" ? pLp.vMax : pLp.uMax);
						return {
							id: `subfeat-cone-y-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
							operation: "add",
							shape: "cone_y",
							xMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
							xMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
							yMin: cYMin,
							yMax: cYMax,
							zMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
							zMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
							centerX: cir.center.u,
							centerZ: cir.center.v,
							uCenterMin,
							vCenterMin,
							uCenterMax,
							vCenterMax,
							radius: cir.radius,
							rMin,
							rMax
						} as any;
					} else {
						const cXMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : pLp.uMin;
						const cXMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : pLp.uMax;
						return {
							id: `subfeat-cone-x-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
							operation: "add",
							shape: "cone_x",
							xMin: cXMin,
							xMax: cXMax,
							yMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
							yMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
							zMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
							zMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
							centerY: cir.center.u,
							centerZ: cir.center.v,
							uCenterMin,
							vCenterMin,
							uCenterMax,
							vCenterMax,
							radius: cir.radius,
							rMin,
							rMax
						} as any;
					}
				}

				// 7. CircleCluster x Axis-Aligned Rectangle -> Cylinder (cylinder_x / cylinder_y / cylinder_z)
				const isF1Rect = f1.featureType === "loop" && isAxisAlignedRectLoop(f1.loop);
				const isF2Rect = f2.featureType === "loop" && isAxisAlignedRectLoop(f2.loop);
				if ((f1.featureType === "circle" && isF2Rect) || (f2.featureType === "circle" && isF1Rect)) {
					const cirFeat = f1.featureType === "circle" ? f1 : f2;
					const cView = f1.featureType === "circle" ? v1 : v2;
					const rectFeat = f1.featureType === "circle" ? f2 : f1;
					const rView = f1.featureType === "circle" ? v2 : v1;
					const cir = cirFeat.outer;
					const rLp = rectFeat.loop;
					markCircleUsed(cir);
					if (cView === "top") {
						return {
							id: `subfeat-cyl-z-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Cylinder Ø${Math.round(cir.radius * 2)}`,
							operation: "add",
							shape: "cylinder_z",
							xMin: cir.center.u - cir.radius,
							xMax: cir.center.u + cir.radius,
							yMin: cir.center.v - cir.radius,
							yMax: cir.center.v + cir.radius,
							zMin: rLp.vMin,
							zMax: rLp.vMax,
							centerX: cir.center.u,
							centerY: cir.center.v,
							radius: cir.radius
						};
					} else if (cView === "front") {
						const cYMin = rView === "top" ? rLp.vMin : rLp.uMin;
						const cYMax = rView === "top" ? rLp.vMax : rLp.uMax;
						return {
							id: `subfeat-cyl-y-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Cylinder Ø${Math.round(cir.radius * 2)}`,
							operation: "add",
							shape: "cylinder_y",
							xMin: cir.center.u - cir.radius,
							xMax: cir.center.u + cir.radius,
							yMin: cYMin,
							yMax: cYMax,
							zMin: cir.center.v - cir.radius,
							zMax: cir.center.v + cir.radius,
							centerX: cir.center.u,
							centerZ: cir.center.v,
							radius: cir.radius
						};
					} else {
						return {
							id: `subfeat-cyl-x-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: `Cylinder Ø${Math.round(cir.radius * 2)}`,
							operation: "add",
							shape: "cylinder_x",
							xMin: rLp.uMin,
							xMax: rLp.uMax,
							yMin: cir.center.u - cir.radius,
							yMax: cir.center.u + cir.radius,
							zMin: cir.center.v - cir.radius,
							zMax: cir.center.v + cir.radius,
							centerY: cir.center.u,
							centerZ: cir.center.v,
							radius: cir.radius
						};
					}
				}

				// 5. Semicircle x Triangle/Trapezoid -> Semi-Cone / Semi-Frustum (pyramid)
				if ((isF1Semi && isF2ConeProf) || (isF2Semi && isF1ConeProf)) {
					const semiFeat = isF1Semi ? f1 : f2;
					const semiView = isF1Semi ? v1 : v2;
					const triFeat = isF1Semi ? f2 : f1;
					const triView = isF1Semi ? v2 : v1;
					const semiProf = semiFeat.profile;
					const semiLp = semiFeat.loop;
					const triProf = triFeat.profile;
					const triLp = triFeat.loop;
					const R = semiProf.radius;
					const uC = semiProf.center.u;
					const vFlat = semiProf.vFlat ?? semiProf.center.v;
					const uFlat = semiProf.uFlat ?? semiProf.center.u;
					const isTrap = triProf.kind === "trapezoid_h" || triProf.kind === "trapezoid_v";
					const rAtMin = triProf.rAtVMin ?? triProf.rAtUMin ?? 0;
					const rAtMax = triProf.rAtVMax ?? triProf.rAtUMax ?? 0;
					const rBig = Math.max(rAtMin, rAtMax, R);
					const rSmall = Math.min(rAtMin, rAtMax);
					const topScale = isTrap && rBig > 1e-3 ? Math.max(0, Math.min(0.98, rSmall / rBig)) : 0;

					if (semiView === "front") {
						const pZMin = Math.min(semiLp.vMin, vFlat);
						const pZMax = Math.max(semiLp.vMax, vFlat);
						const pYMin = triView === "top" ? triLp.vMin : triLp.uMin;
						const pYMax = triView === "top" ? triLp.vMax : triLp.uMax;
						const ax = !isTrap && triProf.apex ? (triView === "top" ? triProf.apex.u : uC) : uC;
						const ay = !isTrap && triProf.apex
							? (triView === "top" ? triProf.apex.v : triProf.apex.u)
							: (rAtMin <= rAtMax ? (triProf.wSlopeMin ?? pYMin) : (triProf.wSlopeMax ?? pYMax));
						return {
							id: `subfeat-semicone-y-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
							operation: "add",
							shape: "pyramid",
							prismAxis: "Y",
							extrudeAxis: "y",
							prismPolygon: semiLp.points,
							polygon2D: semiLp.points,
							prismSegments: semiLp.segments,
							apex3D: [ax, ay, vFlat],
							pyramidTopScale: topScale,
							xMin: semiLp.uMin,
							xMax: semiLp.uMax,
							yMin: pYMin,
							yMax: pYMax,
							zMin: pZMin,
							zMax: pZMax
						} as any;
					} else if (semiView === "top") {
						const pYMin = Math.min(semiLp.vMin, vFlat);
						const pYMax = Math.max(semiLp.vMax, vFlat);
						const pZMin = triLp.vMin;
						const pZMax = triLp.vMax;
						const ax = !isTrap && triProf.apex ? (triView === "front" ? triProf.apex.u : uC) : uC;
						const az = !isTrap && triProf.apex
							? triProf.apex.v
							: (rAtMin <= rAtMax ? (triProf.wSlopeMin ?? pZMin) : (triProf.wSlopeMax ?? pZMax));
						return {
							id: `subfeat-semicone-z-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
							operation: "add",
							shape: "pyramid",
							prismAxis: "Z",
							extrudeAxis: "z",
							prismPolygon: semiLp.points,
							polygon2D: semiLp.points,
							prismSegments: semiLp.segments,
							apex3D: [ax, vFlat, az],
							pyramidTopScale: topScale,
							xMin: semiLp.uMin,
							xMax: semiLp.uMax,
							yMin: pYMin,
							yMax: pYMax,
							zMin: pZMin,
							zMax: pZMax
						} as any;
					} else {
						const pZMin = Math.min(semiLp.vMin, vFlat);
						const pZMax = Math.max(semiLp.vMax, vFlat);
						const pXMin = triLp.uMin;
						const pXMax = triLp.uMax;
						const ax = !isTrap && triProf.apex
							? triProf.apex.u
							: (rAtMin <= rAtMax ? (triProf.wSlopeMin ?? pXMin) : (triProf.wSlopeMax ?? pXMax));
						return {
							id: `subfeat-semicone-x-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
							operation: "add",
							shape: "pyramid",
							prismAxis: "X",
							extrudeAxis: "x",
							prismPolygon: semiLp.points,
							polygon2D: semiLp.points,
							prismSegments: semiLp.segments,
							apex3D: [ax, uFlat, vFlat],
							pyramidTopScale: topScale,
							xMin: pXMin,
							xMax: pXMax,
							yMin: semiLp.uMin,
							yMax: semiLp.uMax,
							zMin: pZMin,
							zMax: pZMax
						} as any;
					}
				}

				// 8. Polygon/Arc-Loop x Rectangle -> Prism / Box
				if (f1.featureType === "loop" && f2.featureType === "loop" && (isF1Rect || isF2Rect)) {
					const profFeat = isF1Rect && !isF2Rect ? f2 : f1;
					const pView = isF1Rect && !isF2Rect ? v2 : v1;
					const rectFeat = isF1Rect && !isF2Rect ? f1 : f2;
					const rView = isF1Rect && !isF2Rect ? v1 : v2;
					const pLp = profFeat.loop;
					const rLp = rectFeat.loop;
					const bothRect = isF1Rect && isF2Rect;
					if (pView === "front") {
						const pYMin = rView === "top" ? rLp.vMin : rLp.uMin;
						const pYMax = rView === "top" ? rLp.vMax : rLp.uMax;
						return {
							id: `subfeat-prism-y-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: bothRect ? "Block" : "Extruded Profile",
							operation: "add",
							shape: bothRect ? "box" : "prism",
							prismAxis: bothRect ? void 0 : "Y",
							extrudeAxis: bothRect ? void 0 : "y",
							prismPolygon: bothRect ? void 0 : pLp.points,
							polygon2D: bothRect ? void 0 : pLp.points,
							prismSegments: bothRect ? void 0 : pLp.segments,
							xMin: pLp.uMin,
							xMax: pLp.uMax,
							yMin: pYMin,
							yMax: pYMax,
							zMin: pLp.vMin,
							zMax: pLp.vMax
						} as any;
					} else if (pView === "top") {
						return {
							id: `subfeat-prism-z-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: bothRect ? "Block" : "Extruded Profile",
							operation: "add",
							shape: bothRect ? "box" : "prism",
							prismAxis: bothRect ? void 0 : "Z",
							extrudeAxis: bothRect ? void 0 : "z",
							prismPolygon: bothRect ? void 0 : pLp.points,
							polygon2D: bothRect ? void 0 : pLp.points,
							prismSegments: bothRect ? void 0 : pLp.segments,
							xMin: pLp.uMin,
							xMax: pLp.uMax,
							yMin: pLp.vMin,
							yMax: pLp.vMax,
							zMin: rLp.vMin,
							zMax: rLp.vMax
						} as any;
					} else {
						return {
							id: `subfeat-prism-x-${pairedAddPrims.length}`,
							featureId: "custom_main",
							label: bothRect ? "Block" : "Extruded Profile",
							operation: "add",
							shape: bothRect ? "box" : "prism",
							prismAxis: bothRect ? void 0 : "X",
							extrudeAxis: bothRect ? void 0 : "x",
							prismPolygon: bothRect ? void 0 : pLp.points,
							polygon2D: bothRect ? void 0 : pLp.points,
							prismSegments: bothRect ? void 0 : pLp.segments,
							xMin: rLp.uMin,
							xMax: rLp.uMax,
							yMin: pLp.uMin,
							yMax: pLp.uMax,
							zMin: pLp.vMin,
							zMax: pLp.vMax
						} as any;
					}
				}

				return null;
			};

			const matched1 = new Set<number>();
			const matched2 = new Set<number>();
			for (let i = 0; i < feats1.length; i++) {
				for (let j = 0; j < feats2.length; j++) {
					const prim = pairSubFeatures(feats1[i], feats2[j]);
					if (prim) {
						pairedAddPrims.push(prim);
						matched1.add(i);
						matched2.add(j);
					}
				}
			}

			// Commit multi-feature composite primitives when >= 2 sub-primitives were paired
			if (pairedAddPrims.length >= 2) {
				for (const idx1 of matched1) {
					if (feats1[idx1].featureType === "loop") feats1[idx1].loop.usedAsAddSubFeature = true;
				}
				for (const idx2 of matched2) {
					if (feats2[idx2].featureType === "loop") feats2[idx2].loop.usedAsAddSubFeature = true;
				}
				basePrimitives.push(...pairedAddPrims);
				bounds.xMin = Math.min(...pairedAddPrims.map((p) => p.xMin));
				bounds.xMax = Math.max(...pairedAddPrims.map((p) => p.xMax));
				bounds.yMin = Math.min(...pairedAddPrims.map((p) => p.yMin));
				bounds.yMax = Math.max(...pairedAddPrims.map((p) => p.yMax));
				bounds.zMin = Math.min(...pairedAddPrims.map((p) => p.zMin));
				bounds.zMax = Math.max(...pairedAddPrims.map((p) => p.zMax));
			}
		}
	}

	if (basePrimitives.length === 0) {
		const loops1 = v1 === "front" ? solidLoopsFront : v1 === "top" ? solidLoopsTop : solidLoopsLeft;
		const loops2 = v2 === "front" ? solidLoopsFront : v2 === "top" ? solidLoopsTop : solidLoopsLeft;
		const lp1 = loops1[0];
		const lp2 = loops2[0];
		const rawProf1 = lp1 ? analyzeLoopProfile(lp1) : null;
		const rawProf2 = lp2 ? analyzeLoopProfile(lp2) : null;
		const prof1 = rawProf1 && rawProf1.kind !== "general" ? rawProf1 : detectSlantedProfileFromRawEntities(v1) || rawProf1;
		const prof2 = rawProf2 && rawProf2.kind !== "general" ? rawProf2 : detectSlantedProfileFromRawEntities(v2) || rawProf2;
		const isConeOrTrapProfile = (p) => p?.kind === "triangle_h" || p?.kind === "triangle_v" || p?.kind === "trapezoid_h" || p?.kind === "trapezoid_v";
		if (prof1?.kind === "semicircle" && (cir2 || prof2?.kind === "semicircle") || prof2?.kind === "semicircle" && (cir1 || prof1?.kind === "semicircle")) {
			if (cir1) markCircleUsed(cir1);
			if (cir2) markCircleUsed(cir2);
			const semiProf = prof1?.kind === "semicircle" ? prof1 : prof2;
			const semiView = prof1?.kind === "semicircle" ? v1 : v2;
			const R = semiProf.radius;
			const sx = semiView === "left" ? .5 * (xMin + xMax) : semiProf.center.u;
			const sy = semiView === "top" ? semiProf.center.v : semiView === "left" ? semiProf.center.u : .5 * (yMin + yMax);
			const sz = semiView === "top" ? .5 * (zMin + zMax) : semiProf.center.v;
			const hZMin = semiView !== "top" && Math.abs(sz - zMin) <= 3.5 && zMax > sz ? sz : zMin;
			const hZMax = semiView !== "top" && Math.abs(sz - zMax) <= 3.5 && zMin < sz ? sz : zMax;
			bounds.zMin = hZMin;
			bounds.zMax = hZMax;
			basePrimitives.push({
				id: "base-hemisphere",
				featureId: "custom_main",
				label: `Hemisphere SR${Math.round(R)}`,
				operation: "add",
				shape: "hemisphere",
				xMin: sx - R,
				xMax: sx + R,
				yMin: sy - R,
				yMax: sy + R,
				zMin: hZMin,
				zMax: hZMax,
				centerX: sx,
				centerY: sy,
				centerZ: sz,
				radius: R
			});
		} else if (cir1 && isConeOrTrapProfile(prof2) || cir2 && isConeOrTrapProfile(prof1)) {
			const cir = cir1 || cir2;
			const cView = cir1 ? v1 : v2;
			const pView = cir1 ? v2 : v1;
			const prof = cir1 ? prof2 : prof1;
			markCircleUsed(cir);
			const cViewCircles = cView === "front" ? circlesFront : cView === "top" ? circlesTop : circlesLeft;
			// Rule 1: Allow eccentric inner circles contained inside the outer circle (not just strictly concentric!)
			const candidateInnerCircles = cViewCircles.filter(
				(c) => c.id !== cir.id && c.lineType === "thick_solid" && dist2D(c.center, cir.center) + c.radius <= cir.radius + 2.5 && c.radius < cir.radius - .5
			);
			let rMin = 0;
			let rMax = 0;
			let uCenterMin = cir.center.u;
			let vCenterMin = cir.center.v;
			let uCenterMax = cir.center.u;
			let vCenterMax = cir.center.v;
			if (prof.kind === "triangle_h") {
				rMin = prof.apex.v > prof.baseV ? cir.radius : 0;
				rMax = prof.apex.v > prof.baseV ? 0 : cir.radius;
				if (prof.apex.v > prof.baseV && prof.apex.u !== void 0 && (cView === "top" && pView === "front" || cView === "front" && pView === "top")) uCenterMax = prof.apex.u;
				if (prof.apex.v <= prof.baseV && prof.apex.u !== void 0 && (cView === "top" && pView === "front" || cView === "front" && pView === "top")) uCenterMin = prof.apex.u;
			} else if (prof.kind === "triangle_v") {
				rMin = prof.apex.u > prof.baseU ? cir.radius : 0;
				rMax = prof.apex.u > prof.baseU ? 0 : cir.radius;
			} else {
				const rawRMin = prof.kind === "trapezoid_h" ? prof.rAtVMin : prof.rAtUMin;
				const rawRMax = prof.kind === "trapezoid_h" ? prof.rAtVMax : prof.rAtUMax;
				const cAtMin = prof.kind === "trapezoid_h" ? prof.cAtVMin : prof.cAtUMin;
				const cAtMax = prof.kind === "trapezoid_h" ? prof.cAtVMax : prof.cAtUMax;
				const matchesInnerSpan = (ic: any, targetR: number, targetC?: number) => {
					if (Math.abs(ic.radius - targetR) > 3.0) return false;
					if (targetC === void 0) return true;
					const sharedC = cView === "front" && pView === "top" ? ic.center.u : cView === "front" && pView === "left" ? ic.center.v : cView === "top" && pView === "front" ? ic.center.u : cView === "top" && pView === "left" ? ic.center.v : cView === "left" && pView === "front" ? ic.center.v : ic.center.u;
					return Math.abs(sharedC - targetC) <= 3.0;
				};
				const matchMinInner = candidateInnerCircles.find((ic) => matchesInnerSpan(ic, rawRMin, cAtMin));
				const matchMaxInner = candidateInnerCircles.find((ic) => matchesInnerSpan(ic, rawRMax, cAtMax));
				if (rawRMin <= rawRMax) {
					rMin = matchMinInner ? matchMinInner.radius : rawRMin;
					rMax = Math.abs(cir.radius - rawRMax) <= 3.0 ? cir.radius : rawRMax;
					if (matchMinInner) {
						uCenterMin = matchMinInner.center.u;
						vCenterMin = matchMinInner.center.v;
					} else if (cAtMin !== void 0) {
						if (cView === "top" && pView === "front" || cView === "front" && pView === "top") uCenterMin = cAtMin;
						else if (cView === "top" && pView === "left") vCenterMin = cAtMin;
						else if (cView === "front" && pView === "left" || cView === "left" && pView === "front") vCenterMin = cAtMin;
						else if (cView === "left" && pView === "top") uCenterMin = cAtMin;
					}
				} else {
					rMin = Math.abs(cir.radius - rawRMin) <= 3.0 ? cir.radius : rawRMin;
					rMax = matchMaxInner ? matchMaxInner.radius : rawRMax;
					if (matchMaxInner) {
						uCenterMax = matchMaxInner.center.u;
						vCenterMax = matchMaxInner.center.v;
					} else if (cAtMax !== void 0) {
						if (cView === "top" && pView === "front" || cView === "front" && pView === "top") uCenterMax = cAtMax;
						else if (cView === "top" && pView === "left") vCenterMax = cAtMax;
						else if (cView === "front" && pView === "left" || cView === "left" && pView === "front") vCenterMax = cAtMax;
						else if (cView === "left" && pView === "top") uCenterMax = cAtMax;
					}
				}
			}
			const pSlots = pView === "top" ? slotsTop : pView === "front" ? slotsFront : slotsLeft;
			const hasMatchingHoleDashedInPView = (ic) => {
				const sharedCoord = cView === "front" && pView === "top" ? ic.center.u : cView === "front" && pView === "left" ? ic.center.v : cView === "top" && pView === "front" ? ic.center.u : cView === "top" && pView === "left" ? ic.center.v : cView === "left" && pView === "front" ? ic.center.v : ic.center.u;
				const s1 = sharedCoord - ic.radius;
				const s2 = sharedCoord + ic.radius;
				const checkU = cView === "front" && pView === "top" || cView === "top" && pView === "front" || cView === "top" && pView === "left";
				if (checkU) {
					return pSlots.uBands.some((b) => Math.abs(b.u1 - s1) <= 2.5 && Math.abs(b.u2 - s2) <= 2.5) || pSlots.uSlots.some((s) => Math.abs(s.uMin - s1) <= 2.5 && Math.abs(s.uMax - s2) <= 2.5);
				}
				return pSlots.vBands.some((b) => Math.abs(b.v1 - s1) <= 2.5 && Math.abs(b.v2 - s2) <= 2.5) || pSlots.uSlots.some((s) => Math.abs(s.vMin - s1) <= 2.5 && Math.abs(s.vMax - s2) <= 2.5);
			};
			for (const ic of candidateInnerCircles) {
				if ((Math.abs(ic.radius - rMin) <= 3.0 || Math.abs(ic.radius - rMax) <= 3.0) && !hasMatchingHoleDashedInPView(ic)) {
					markCircleUsed(ic);
				}
			}
			const pViewArcs = userEntities.filter((e) => e.view === pView && e.type === "arc" && e.lineType === "thick_solid");
			for (const arcEnt of pViewArcs) {
				usedEntityIds.add(arcEnt.id);
				if (pView === "top") pairedSubtracts.push({
					id: `sub-frustum-notch-z-${pairedSubtracts.length}`,
					featureId: arcEnt.featureId || `notch_z_${pairedSubtracts.length}`,
					label: `Cylindrical Notch R${Math.round(arcEnt.radius)}`,
					operation: "subtract",
					shape: "cylinder_z",
					xMin: arcEnt.center.u - arcEnt.radius,
					xMax: arcEnt.center.u + arcEnt.radius,
					yMin: arcEnt.center.v - arcEnt.radius,
					yMax: arcEnt.center.v + arcEnt.radius,
					zMin: zMin - 2,
					zMax: zMax + 2,
					centerX: arcEnt.center.u,
					centerY: arcEnt.center.v,
					radius: arcEnt.radius,
					isInternalFeature: false
				});
				else if (pView === "front") pairedSubtracts.push({
					id: `sub-frustum-notch-y-${pairedSubtracts.length}`,
					featureId: arcEnt.featureId || `notch_y_${pairedSubtracts.length}`,
					label: `Cylindrical Notch R${Math.round(arcEnt.radius)}`,
					operation: "subtract",
					shape: "cylinder_y",
					xMin: arcEnt.center.u - arcEnt.radius,
					xMax: arcEnt.center.u + arcEnt.radius,
					yMin: yMin - 2,
					yMax: yMax + 2,
					zMin: arcEnt.center.v - arcEnt.radius,
					zMax: arcEnt.center.v + arcEnt.radius,
					centerX: arcEnt.center.u,
					centerZ: arcEnt.center.v,
					radius: arcEnt.radius,
					isInternalFeature: false
				});
				else if (pView === "left") pairedSubtracts.push({
					id: `sub-frustum-notch-x-${pairedSubtracts.length}`,
					featureId: arcEnt.featureId || `notch_x_${pairedSubtracts.length}`,
					label: `Cylindrical Notch R${Math.round(arcEnt.radius)}`,
					operation: "subtract",
					shape: "cylinder_x",
					xMin: xMin - 2,
					xMax: xMax + 2,
					yMin: arcEnt.center.u - arcEnt.radius,
					yMax: arcEnt.center.u + arcEnt.radius,
					zMin: arcEnt.center.v - arcEnt.radius,
					zMax: arcEnt.center.v + arcEnt.radius,
					centerY: arcEnt.center.u,
					centerZ: arcEnt.center.v,
					radius: arcEnt.radius,
					isInternalFeature: false
				});
			}
			if (cView === "top") {
				const coneZMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : zMin;
				const coneZMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : zMax;
				bounds.zMin = coneZMin;
				bounds.zMax = coneZMax;
				basePrimitives.push({
					id: "base-cone-z",
					featureId: "custom_main",
					label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
					operation: "add",
					shape: "cone_z",
					xMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
					xMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
					yMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
					yMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
					zMin: coneZMin,
					zMax: coneZMax,
					centerX: cir.center.u,
					centerY: cir.center.v,
					uCenterMin,
					vCenterMin,
					uCenterMax,
					vCenterMax,
					radius: cir.radius,
					rMin,
					rMax
				} as any);
			} else if (cView === "front") {
				const coneYMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : yMin;
				const coneYMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : yMax;
				bounds.yMin = coneYMin;
				bounds.yMax = coneYMax;
				basePrimitives.push({
					id: "base-cone-y",
					featureId: "custom_main",
					label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
					operation: "add",
					shape: "cone_y",
					xMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
					xMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
					yMin: coneYMin,
					yMax: coneYMax,
					zMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
					zMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
					centerX: cir.center.u,
					centerZ: cir.center.v,
					uCenterMin,
					vCenterMin,
					uCenterMax,
					vCenterMax,
					radius: cir.radius,
					rMin,
					rMax
				} as any);
			} else if (cView === "left") {
				const coneXMin = prof.wSlopeMin !== void 0 ? prof.wSlopeMin : xMin;
				const coneXMax = prof.wSlopeMax !== void 0 ? prof.wSlopeMax : xMax;
				bounds.xMin = coneXMin;
				bounds.xMax = coneXMax;
				basePrimitives.push({
					id: "base-cone-x",
					featureId: "custom_main",
					label: rMin === 0 || rMax === 0 ? `Cone Ø${Math.round(cir.radius * 2)}` : `Frustum Ø${Math.round(Math.min(rMin, rMax) * 2)}-Ø${Math.round(Math.max(rMin, rMax) * 2)}`,
					operation: "add",
					shape: "cone_x",
					xMin: coneXMin,
					xMax: coneXMax,
					yMin: Math.min(uCenterMin - rMin, uCenterMax - rMax, cir.center.u - cir.radius),
					yMax: Math.max(uCenterMin + rMin, uCenterMax + rMax, cir.center.u + cir.radius),
					zMin: Math.min(vCenterMin - rMin, vCenterMax - rMax, cir.center.v - cir.radius),
					zMax: Math.max(vCenterMin + rMin, vCenterMax + rMax, cir.center.v + cir.radius),
					centerY: cir.center.u,
					centerZ: cir.center.v,
					uCenterMin,
					vCenterMin,
					uCenterMax,
					vCenterMax,
					radius: cir.radius,
					rMin,
					rMax
				} as any);
			}
		} else if (lp1 && lp2 && (prof1?.kind === "semicircle" && isConeOrTrapProfile(prof2) || prof2?.kind === "semicircle" && isConeOrTrapProfile(prof1))) {
			const semiProf = prof1?.kind === "semicircle" ? prof1 : prof2;
			const semiLp = prof1?.kind === "semicircle" ? lp1 : lp2;
			const semiView = prof1?.kind === "semicircle" ? v1 : v2;
			const triProf = prof1?.kind === "semicircle" ? prof2 : prof1;
			const triView = prof1?.kind === "semicircle" ? v2 : v1;
			const R = semiProf.radius;
			const uC = semiProf.center.u;
			const vFlat = semiProf.vFlat ?? semiProf.center.v;
			const uFlat = semiProf.uFlat ?? semiProf.center.u;
			const isTrap = triProf.kind === "trapezoid_h" || triProf.kind === "trapezoid_v";
			const rAtMin = triProf.rAtVMin ?? triProf.rAtUMin ?? 0;
			const rAtMax = triProf.rAtVMax ?? triProf.rAtUMax ?? 0;
			const rBig = Math.max(rAtMin, rAtMax, R);
			const rSmall = Math.min(rAtMin, rAtMax);
			const topScale = isTrap && rBig > 1e-3 ? Math.max(0, Math.min(0.98, rSmall / rBig)) : 0;
			if (semiView === "front") {
				const pZMin = Math.min(semiLp.vMin, vFlat);
				const pZMax = Math.max(semiLp.vMax, vFlat);
				bounds.zMin = pZMin;
				bounds.zMax = pZMax;
				let ax = uC;
				let ay = yMax;
				if (!isTrap && triProf.apex) {
					if (triView === "top") {
						ax = triProf.apex.u;
						ay = triProf.apex.v;
					} else {
						ax = uC;
						ay = triProf.apex.u;
					}
				} else if (isTrap) {
					ay = rAtMin <= rAtMax ? (triProf.wSlopeMin ?? yMin) : (triProf.wSlopeMax ?? yMax);
				}
				basePrimitives.push({
					id: "base-semicone-y",
					featureId: "custom_main",
					label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
					operation: "add",
					shape: "pyramid",
					prismAxis: "Y",
					extrudeAxis: "y",
					prismPolygon: semiLp.points,
					polygon2D: semiLp.points,
					prismSegments: semiLp.segments,
					apex3D: [ax, ay, vFlat],
					pyramidTopScale: topScale,
					xMin: semiLp.uMin,
					xMax: semiLp.uMax,
					yMin,
					yMax,
					zMin: pZMin,
					zMax: pZMax
				} as any);
			} else if (semiView === "top") {
				const pYMin = Math.min(semiLp.vMin, vFlat);
				const pYMax = Math.max(semiLp.vMax, vFlat);
				bounds.yMin = pYMin;
				bounds.yMax = pYMax;
				let ax = uC;
				let az = zMax;
				if (!isTrap && triProf.apex) {
					ax = triView === "front" ? triProf.apex.u : uC;
					az = triProf.apex.v;
				} else if (isTrap) {
					az = rAtMin <= rAtMax ? (triProf.wSlopeMin ?? zMin) : (triProf.wSlopeMax ?? zMax);
				}
				basePrimitives.push({
					id: "base-semicone-z",
					featureId: "custom_main",
					label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
					operation: "add",
					shape: "pyramid",
					prismAxis: "Z",
					extrudeAxis: "z",
					prismPolygon: semiLp.points,
					polygon2D: semiLp.points,
					prismSegments: semiLp.segments,
					apex3D: [ax, vFlat, az],
					pyramidTopScale: topScale,
					xMin: semiLp.uMin,
					xMax: semiLp.uMax,
					yMin: pYMin,
					yMax: pYMax,
					zMin,
					zMax
				} as any);
			} else {
				const pZMin = Math.min(semiLp.vMin, vFlat);
				const pZMax = Math.max(semiLp.vMax, vFlat);
				bounds.zMin = pZMin;
				bounds.zMax = pZMax;
				const ax = !isTrap && triProf.apex ? triProf.apex.u : rAtMin <= rAtMax ? (triProf.wSlopeMin ?? xMin) : (triProf.wSlopeMax ?? xMax);
				basePrimitives.push({
					id: "base-semicone-x",
					featureId: "custom_main",
					label: isTrap ? `Semi-Frustum R${Math.round(R)}` : `Semi-Cone R${Math.round(R)}`,
					operation: "add",
					shape: "pyramid",
					prismAxis: "X",
					extrudeAxis: "x",
					prismPolygon: semiLp.points,
					polygon2D: semiLp.points,
					prismSegments: semiLp.segments,
					apex3D: [ax, uFlat, vFlat],
					pyramidTopScale: topScale,
					xMin,
					xMax,
					yMin: semiLp.uMin,
					yMax: semiLp.uMax,
					zMin: pZMin,
					zMax: pZMax
				} as any);
			}
		} else if (lp1 && lp2 && ((prof1?.kind === "triangle_h" || prof1?.kind === "triangle_v") && prof2?.kind === "general" || (prof2?.kind === "triangle_h" || prof2?.kind === "triangle_v") && prof1?.kind === "general")) {
			const isP1Tri = prof1?.kind === "triangle_h" || prof1?.kind === "triangle_v";
			const triProf = isP1Tri ? prof1 : prof2;
			const triView = isP1Tri ? v1 : v2;
			const baseLoop = isP1Tri ? lp2 : lp1;
			const baseView = isP1Tri ? v2 : v1;
			if (baseView === "top" && (triView === "front" || triView === "left")) {
				const ax = triView === "front" ? triProf.apex.u : .5 * (xMin + xMax);
				const ay = triView === "left" ? triProf.apex.u : .5 * (yMin + yMax);
				const az = triProf.apex.v;
				basePrimitives.push({
					id: "base-pyramid-z",
					featureId: "custom_main",
					label: "Polygon Pyramid",
					operation: "add",
					shape: "pyramid",
					prismAxis: "Z",
					extrudeAxis: "z",
					prismPolygon: baseLoop.points,
					polygon2D: baseLoop.points,
					prismSegments: baseLoop.segments,
					apex3D: [
						ax,
						ay,
						az
					],
					xMin,
					xMax,
					yMin,
					yMax,
					zMin,
					zMax
				});
			} else if (baseView === "front" && (triView === "top" || triView === "left")) {
				const ax = triView === "top" ? triProf.apex.u : .5 * (xMin + xMax);
				const ay = triView === "top" ? triProf.apex.v : triProf.apex.u;
				const az = triView === "left" ? triProf.apex.v : .5 * (zMin + zMax);
				basePrimitives.push({
					id: "base-pyramid-y",
					featureId: "custom_main",
					label: "Polygon Pyramid",
					operation: "add",
					shape: "pyramid",
					prismAxis: "Y",
					extrudeAxis: "y",
					prismPolygon: baseLoop.points,
					polygon2D: baseLoop.points,
					prismSegments: baseLoop.segments,
					apex3D: [
						ax,
						ay,
						az
					],
					xMin,
					xMax,
					yMin,
					yMax,
					zMin,
					zMax
				});
			}
		} else if (lp1 && !lp2 && !cir2 || lp2 && !lp1 && !cir1) {
			const polyLp = lp1 || lp2;
			const polyView = lp1 ? v1 : v2;
			const lineView = lp1 ? v2 : v1;
			const lineEnts = userEntities.filter((e) => e.view === lineView && e.type === "line" && e.lineType === "thick_solid") as CadLineEntity[];
			if (lineEnts.length === 1 && polyLp.points.length >= 3) {
				const ln = lineEnts[0];
				if (polyView === "front" && lineView === "top" && Math.abs(ln.p2.u - ln.p1.u) > 2) {
					const verts3D: [number, number, number][] = polyLp.points.map((pt) => {
						const t = (pt.u - ln.p1.u) / (ln.p2.u - ln.p1.u);
						return [pt.u, ln.p1.v + t * (ln.p2.v - ln.p1.v), pt.v];
					});
					basePrimitives.push({
						id: "base-plane-sheet",
						featureId: "custom_main",
						label: "Spatial Plane Sheet",
						operation: "add",
						shape: "plane_sheet",
						vertices3D: verts3D,
						xMin,
						xMax,
						yMin,
						yMax,
						zMin,
						zMax
					});
				} else if (polyView === "top" && lineView === "front" && Math.abs(ln.p2.u - ln.p1.u) > 2) {
					const verts3D: [number, number, number][] = polyLp.points.map((pt) => {
						const t = (pt.u - ln.p1.u) / (ln.p2.u - ln.p1.u);
						return [pt.u, pt.v, ln.p1.v + t * (ln.p2.v - ln.p1.v)];
					});
					basePrimitives.push({
						id: "base-plane-sheet",
						featureId: "custom_main",
						label: "Spatial Plane Sheet",
						operation: "add",
						shape: "plane_sheet",
						vertices3D: verts3D,
						xMin,
						xMax,
						yMin,
						yMax,
						zMin,
						zMax
					});
				}
			}
		} else if (solidLoopsFront.length >= 3 && solidLoopsTop.length >= 1 && circlesTop.length >= 1) {
			const subLoopsF = solidLoopsFront.slice(1);
			const matchedSubCones: Primitive3D[] = [];
			const matchedSubBoxes: Primitive3D[] = [];
			for (const subLp of subLoopsF) {
				const sp = analyzeLoopProfile(subLp);
				const matchCir = circlesTop.find((c) => Math.abs(c.center.u - c.radius - subLp.uMin) <= 2.5 && Math.abs(c.center.u + c.radius - subLp.uMax) <= 2.5);
				if (matchCir && (sp.kind === "triangle_h" || sp.kind === "trapezoid_h" || sp.kind === "semicircle")) {
					markCircleUsed(matchCir);
					if (sp.kind === "semicircle") {
						matchedSubCones.push({
							id: `boss-hemi-${matchedSubCones.length}`,
							featureId: "stacked_hemi",
							label: `Hemisphere SR${Math.round(matchCir.radius)}`,
							operation: "add",
							shape: "hemisphere",
							xMin: matchCir.center.u - matchCir.radius,
							xMax: matchCir.center.u + matchCir.radius,
							yMin: matchCir.center.v - matchCir.radius,
							yMax: matchCir.center.v + matchCir.radius,
							zMin: subLp.vMin,
							zMax: subLp.vMax,
							centerX: matchCir.center.u,
							centerY: matchCir.center.v,
							centerZ: subLp.vMin,
							radius: matchCir.radius
						});
					} else {
						const rMin = sp.kind === "triangle_h" ? sp.apex.v > sp.baseV ? matchCir.radius : 0 : sp.rAtVMin;
						const rMax = sp.kind === "triangle_h" ? sp.apex.v > sp.baseV ? 0 : matchCir.radius : sp.rAtVMax;
						matchedSubCones.push({
							id: `boss-cone-${matchedSubCones.length}`,
							featureId: "stacked_cone",
							label: `Cone Ø${Math.round(matchCir.radius * 2)}`,
							operation: "add",
							shape: "cone_z",
							xMin: matchCir.center.u - matchCir.radius,
							xMax: matchCir.center.u + matchCir.radius,
							yMin: matchCir.center.v - matchCir.radius,
							yMax: matchCir.center.v + matchCir.radius,
							zMin: subLp.vMin,
							zMax: subLp.vMax,
							centerX: matchCir.center.u,
							centerY: matchCir.center.v,
							radius: matchCir.radius,
							rMin,
							rMax
						});
					}
				} else {
					matchedSubBoxes.push({
						id: `base-layer-box-${matchedSubBoxes.length}`,
						featureId: "custom_main",
						label: "Base Layer Block",
						operation: "add",
						shape: "box",
						xMin: subLp.uMin,
						xMax: subLp.uMax,
						yMin,
						yMax,
						zMin: subLp.vMin,
						zMax: subLp.vMax
					});
				}
			}
			if (matchedSubCones.length > 0 && matchedSubBoxes.length > 0) {
				basePrimitives.push(...matchedSubBoxes, ...matchedSubCones);
			}
		}
	}
	const buildViewOuterExtrusion = (v, isFirstBase) => {
		const op = isFirstBase ? "add" : "intersect";
		const circles = v === "front" ? circlesFront : v === "top" ? circlesTop : circlesLeft;
		const loops = v === "front" ? solidLoopsFront : v === "top" ? solidLoopsTop : solidLoopsLeft;
		const vB = v === "front" ? bFront : v === "top" ? bTop : bLeft;
		if (!vB) return null;
		const outerCircle = circles.find((c) => c.lineType === "thick_solid" && Math.abs(c.radius * 2 - (vB.uMax - vB.uMin)) <= 3 && Math.abs(c.radius * 2 - (vB.vMax - vB.vMin)) <= 3);
		if (outerCircle) {
			markCircleUsed(outerCircle);
			if (v === "top") return {
				id: `base-cyl-z`,
				featureId: "custom_main",
				label: `Cylinder Ø${Math.round(outerCircle.radius * 2)}`,
				operation: op,
				shape: "cylinder_z",
				xMin: outerCircle.center.u - outerCircle.radius,
				xMax: outerCircle.center.u + outerCircle.radius,
				yMin: outerCircle.center.v - outerCircle.radius,
				yMax: outerCircle.center.v + outerCircle.radius,
				zMin,
				zMax,
				centerX: outerCircle.center.u,
				centerY: outerCircle.center.v,
				radius: outerCircle.radius
			};
			if (v === "front") return {
				id: `base-cyl-y`,
				featureId: "custom_main",
				label: `Cylinder Ø${Math.round(outerCircle.radius * 2)}`,
				operation: op,
				shape: "cylinder_y",
				xMin: outerCircle.center.u - outerCircle.radius,
				xMax: outerCircle.center.u + outerCircle.radius,
				yMin,
				yMax,
				zMin: outerCircle.center.v - outerCircle.radius,
				zMax: outerCircle.center.v + outerCircle.radius,
				centerX: outerCircle.center.u,
				centerZ: outerCircle.center.v,
				radius: outerCircle.radius
			};
			return {
				id: `base-cyl-x`,
				featureId: "custom_main",
				label: `Cylinder Ø${Math.round(outerCircle.radius * 2)}`,
				operation: op,
				shape: "cylinder_x",
				xMin,
				xMax,
				yMin: outerCircle.center.u - outerCircle.radius,
				yMax: outerCircle.center.u + outerCircle.radius,
				zMin: outerCircle.center.v - outerCircle.radius,
				zMax: outerCircle.center.v + outerCircle.radius,
				centerY: outerCircle.center.u,
				centerZ: outerCircle.center.v,
				radius: outerCircle.radius
			};
		}
		if (loops.length > 0) {
			const outerLoop = loops[0];
			const isAxisAlignedRect = !outerLoop.segments.some((s) => s.kind === "arc") && outerLoop.points.length === 4 && Math.abs(outerLoop.area - (outerLoop.uMax - outerLoop.uMin) * (outerLoop.vMax - outerLoop.vMin)) <= 2;
			if (v === "front") return {
				id: `base-ext-front`,
				featureId: "custom_main",
				label: isAxisAlignedRect ? "Base Block" : "Extruded Front Profile",
				operation: op,
				shape: isAxisAlignedRect ? "box" : "prism",
				prismAxis: isAxisAlignedRect ? void 0 : "Y",
				extrudeAxis: isAxisAlignedRect ? void 0 : "y",
				prismPolygon: isAxisAlignedRect ? void 0 : outerLoop.points,
				polygon2D: isAxisAlignedRect ? void 0 : outerLoop.points,
				prismSegments: isAxisAlignedRect ? void 0 : outerLoop.segments,
				xMin: outerLoop.uMin,
				xMax: outerLoop.uMax,
				yMin,
				yMax,
				zMin: outerLoop.vMin,
				zMax: outerLoop.vMax
			};
			if (v === "top") return {
				id: `base-ext-top`,
				featureId: "custom_main",
				label: isAxisAlignedRect ? "Base Block" : "Extruded Top Profile",
				operation: op,
				shape: isAxisAlignedRect ? "box" : "prism",
				prismAxis: isAxisAlignedRect ? void 0 : "Z",
				extrudeAxis: isAxisAlignedRect ? void 0 : "z",
				prismPolygon: isAxisAlignedRect ? void 0 : outerLoop.points,
				polygon2D: isAxisAlignedRect ? void 0 : outerLoop.points,
				prismSegments: isAxisAlignedRect ? void 0 : outerLoop.segments,
				xMin: outerLoop.uMin,
				xMax: outerLoop.uMax,
				yMin: outerLoop.vMin,
				yMax: outerLoop.vMax,
				zMin,
				zMax
			};
			return {
				id: `base-ext-left`,
				featureId: "custom_main",
				label: isAxisAlignedRect ? "Base Block" : "Extruded Left Profile",
				operation: op,
				shape: isAxisAlignedRect ? "box" : "prism",
				prismAxis: isAxisAlignedRect ? void 0 : "X",
				extrudeAxis: isAxisAlignedRect ? void 0 : "x",
				prismPolygon: isAxisAlignedRect ? void 0 : outerLoop.points,
				polygon2D: isAxisAlignedRect ? void 0 : outerLoop.points,
				prismSegments: isAxisAlignedRect ? void 0 : outerLoop.segments,
				xMin,
				xMax,
				yMin: outerLoop.uMin,
				yMax: outerLoop.uMax,
				zMin: outerLoop.vMin,
				zMax: outerLoop.vMax
			};
		}
		return null;
	};
	if (basePrimitives.length === 0) {
		const ext1 = buildViewOuterExtrusion(v1, true);
		const ext2 = buildViewOuterExtrusion(v2, false);
		const isRedundantBoundingBox = (nonBox, boxPrim) => {
			return Math.abs(nonBox.xMin - boxPrim.xMin) <= 2 && Math.abs(nonBox.xMax - boxPrim.xMax) <= 2 && Math.abs(nonBox.yMin - boxPrim.yMin) <= 2 && Math.abs(nonBox.yMax - boxPrim.yMax) <= 2 && Math.abs(nonBox.zMin - boxPrim.zMin) <= 2 && Math.abs(nonBox.zMax - boxPrim.zMax) <= 2;
		};
		if (ext1 && ext2) {
			if ((ext1.shape.startsWith("cylinder_") || ext1.shape === "prism") && ext2.shape === "box" && isRedundantBoundingBox(ext1, ext2)) basePrimitives.push(ext1);
			else if ((ext2.shape.startsWith("cylinder_") || ext2.shape === "prism") && ext1.shape === "box" && isRedundantBoundingBox(ext2, ext1)) basePrimitives.push({
				...ext2,
				operation: "add"
			});
			else if (ext1.shape === "box" && ext2.shape === "box") basePrimitives.push({
				...ext1,
				xMin: Math.max(ext1.xMin, ext2.xMin),
				xMax: Math.min(ext1.xMax, ext2.xMax),
				yMin: Math.max(ext1.yMin, ext2.yMin),
				yMax: Math.min(ext1.yMax, ext2.yMax),
				zMin: Math.max(ext1.zMin, ext2.zMin),
				zMax: Math.min(ext1.zMax, ext2.zMax)
			});
			else if (ext1.shape === "box" && ext2.shape !== "box") basePrimitives.push({
				...ext2,
				operation: "add"
			}, {
				...ext1,
				operation: "intersect"
			});
			else basePrimitives.push(ext1, ext2);
		} else if (ext1) basePrimitives.push(ext1);
		else if (ext2) basePrimitives.push({
			...ext2,
			operation: "add"
		});
	}
	if (basePrimitives.length === 0) return [];
	const underConstrainedLoops = [];
	const PAIR_TOL = 2.5;
	const usedFrontUBands = /* @__PURE__ */ new Set();
	const usedFrontVBands = /* @__PURE__ */ new Set();
	const usedFrontUSlots = /* @__PURE__ */ new Set();
	const usedTopUBands = /* @__PURE__ */ new Set();
	const usedTopVBands = /* @__PURE__ */ new Set();
	const usedTopUSlots = /* @__PURE__ */ new Set();
	const usedLeftUBands = /* @__PURE__ */ new Set();
	const usedLeftVBands = /* @__PURE__ */ new Set();
	const usedLeftUSlots = /* @__PURE__ */ new Set();
	const matchesArcOnOuterLoop = (outerLoops, sMin, sMax, coord) => {
		if (outerLoops.length === 0) return false;
		const keyVals: number[] = [];
		for (const seg of outerLoops[0].segments) {
			if (seg.p1) keyVals.push(coord === "u" ? seg.p1.u : seg.p1.v);
			if (seg.p2) keyVals.push(coord === "u" ? seg.p2.u : seg.p2.v);
			if (seg.kind === "arc" && seg.center && seg.radius !== void 0) {
				const ab = getArcExactBounds(seg.center, seg.radius, seg.startAngle ?? 0, seg.endAngle ?? Math.PI * 2);
				const aMin = coord === "u" ? ab.uMin : ab.vMin;
				const aMax = coord === "u" ? ab.uMax : ab.vMax;
				const pMin = coord === "u" ? Math.min(seg.p1.u, seg.p2.u) : Math.min(seg.p1.v, seg.p2.v);
				const pMax = coord === "u" ? Math.max(seg.p1.u, seg.p2.u) : Math.max(seg.p1.v, seg.p2.v);
				keyVals.push(aMin, aMax, pMin, pMax);
				if (Math.abs(pMin - sMin) <= PAIR_TOL && Math.abs(pMax - sMax) <= PAIR_TOL || Math.abs(aMin - sMin) <= PAIR_TOL && Math.abs(aMax - sMax) <= PAIR_TOL) return true;
			}
		}
		if (keyVals.some((kv) => Math.abs(kv - sMin) <= PAIR_TOL) && keyVals.some((kv) => Math.abs(kv - sMax) <= PAIR_TOL)) {
			return true;
		}
		return false;
	};
	const makeRectLoop = (uMin, uMax, vMin, vMax) => {
		const pts = [
			{
				u: uMin,
				v: vMin
			},
			{
				u: uMax,
				v: vMin
			},
			{
				u: uMax,
				v: vMax
			},
			{
				u: uMin,
				v: vMax
			}
		];
		return {
			points: pts,
			segments: pts.map((p, i) => ({
				kind: "line",
				p1: p,
				p2: pts[(i + 1) % 4]
			})),
			area: (uMax - uMin) * (vMax - vMin),
			uMin,
			uMax,
			vMin,
			vMax,
			lineType: "thick_solid"
		};
	};
	const isSameOuterLoop = (lp, outerLoops, vB) => {
		if (!vB) return true;
		if (lp.usedAsAddSubFeature) return true;
		if (outerLoops.length > 0) {
			const outer = outerLoops[0];
			if (Math.abs(lp.uMin - outer.uMin) <= 1.5 && Math.abs(lp.uMax - outer.uMax) <= 1.5 && Math.abs(lp.vMin - outer.vMin) <= 1.5 && Math.abs(lp.vMax - outer.vMax) <= 1.5) return true;
			if (
				outerLoops.some(
					(ol: any) =>
						ol.usedAsAddSubFeature &&
						Math.abs(lp.uMin - ol.uMin) <= 1.5 &&
						Math.abs(lp.uMax - ol.uMax) <= 1.5 &&
						Math.abs(lp.vMin - ol.vMin) <= 1.5 &&
						Math.abs(lp.vMax - ol.vMax) <= 1.5
				)
			) {
				return true;
			}
		}
		if (lp.uMin <= vB.uMin + 1.5 && lp.uMax >= vB.uMax - 1.5 && lp.vMin <= vB.vMin + 1.5 && lp.vMax >= vB.vMax - 1.5) return true;
		const viewArea = Math.max(1, (vB.uMax - vB.uMin) * (vB.vMax - vB.vMin));
		if (lp.lineType === "thick_solid" && lp.area >= .9 * viewArea) return true;
		return false;
	};
	const makeBandLoop = (uMin, uMax, vMin, vMax, slantedPoly?: any) => {
		if (Array.isArray(slantedPoly) && slantedPoly.length >= 3 && slantedPoly.every((p) => Number.isFinite(p.u) && Number.isFinite(p.v))) return {
			points: slantedPoly,
			segments: slantedPoly.map((p, i) => ({
				kind: "line",
				p1: p,
				p2: slantedPoly[(i + 1) % slantedPoly.length]
			})),
			area: polygonArea2D(slantedPoly),
			uMin,
			uMax,
			vMin,
			vMax,
			lineType: "thin_dashed",
			isSlantedPrism: true
		};
		return makeRectLoop(uMin, uMax, vMin, vMax);
	};
	const innerLoopsFront = allLoopsFront.filter((lp) => {
		if (isSameOuterLoop(lp, solidLoopsFront, bFront)) return false;
		if (Math.abs(lp.vMin - bFront.vMin) <= 1.5 && Math.abs(lp.vMax - bFront.vMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsTop, lp.uMin, lp.uMax, "u")) return false;
		if (Math.abs(lp.uMin - bFront.uMin) <= 1.5 && Math.abs(lp.uMax - bFront.uMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsLeft, lp.vMin, lp.vMax, "v")) return false;
		return true;
	});
	if (bFront) {
		for (const sb of slotsFront.solidVBands) if (!innerLoopsFront.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsFront, sb.v1, sb.v2, "v")) innerLoopsFront.push(makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2));
		slotsFront.vBands.forEach((sb, bIdx) => {
			if (!innerLoopsFront.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsFront, sb.v1, sb.v2, "v")) {
				const lp: any = makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2, (sb as any).slantedPoly);
				lp._vBandIdx = bIdx;
				innerLoopsFront.push(lp);
			}
		});
	}
	const innerLoopsTop = allLoopsTop.filter((lp) => {
		if (isSameOuterLoop(lp, solidLoopsTop, bTop)) return false;
		if (Math.abs(lp.vMin - bTop.vMin) <= 1.5 && Math.abs(lp.vMax - bTop.vMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsFront, lp.uMin, lp.uMax, "u")) return false;
		if (Math.abs(lp.uMin - bTop.uMin) <= 1.5 && Math.abs(lp.uMax - bTop.uMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsLeft, lp.vMin, lp.vMax, "u")) return false;
		return true;
	});
	if (bTop) {
		for (const sb of slotsTop.solidVBands) if (!innerLoopsTop.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsTop, sb.v1, sb.v2, "v")) innerLoopsTop.push(makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2));
		slotsTop.vBands.forEach((sb, bIdx) => {
			if (!innerLoopsTop.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsTop, sb.v1, sb.v2, "v")) {
				const lp: any = makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2, (sb as any).slantedPoly);
				lp._vBandIdx = bIdx;
				innerLoopsTop.push(lp);
			}
		});
	}
	const innerLoopsLeft = allLoopsLeft.filter((lp) => {
		if (isSameOuterLoop(lp, solidLoopsLeft, bLeft)) return false;
		if (Math.abs(lp.vMin - bLeft.vMin) <= 1.5 && Math.abs(lp.vMax - bLeft.vMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsTop, lp.uMin, lp.uMax, "v")) return false;
		if (Math.abs(lp.uMin - bLeft.uMin) <= 1.5 && Math.abs(lp.uMax - bLeft.uMax) <= 1.5 && matchesArcOnOuterLoop(solidLoopsFront, lp.vMin, lp.vMax, "v")) return false;
		return true;
	});
	if (bLeft) {
		for (const sb of slotsLeft.solidVBands) if (!innerLoopsLeft.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsLeft, sb.v1, sb.v2, "v")) innerLoopsLeft.push(makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2));
		slotsLeft.vBands.forEach((sb, bIdx) => {
			if (!innerLoopsLeft.some((lp) => Math.abs(lp.uMin - sb.uMin) <= PAIR_TOL && Math.abs(lp.uMax - sb.uMax) <= PAIR_TOL && Math.abs(lp.vMin - sb.v1) <= PAIR_TOL && Math.abs(lp.vMax - sb.v2) <= PAIR_TOL) && !matchesArcOnOuterLoop(solidLoopsLeft, sb.v1, sb.v2, "v")) {
				const lp: any = makeBandLoop(sb.uMin, sb.uMax, sb.v1, sb.v2, (sb as any).slantedPoly);
				lp._vBandIdx = bIdx;
				innerLoopsLeft.push(lp);
			}
		});
	}
	const isBandEndOnViewExterior = (outerLoops, viewCircles, vB, uCenter, uEdge1, uEdge2, vEnd, dirV) => {
		if (vB) {
			const outerCir = viewCircles.find((c) => c.lineType === "thick_solid" && Math.abs(c.radius * 2 - (vB.uMax - vB.uMin)) <= 3 && Math.abs(c.radius * 2 - (vB.vMax - vB.vMin)) <= 3);
			if (outerCir) {
				const dx1 = Math.abs(uEdge1 - outerCir.center.u);
				const dx2 = Math.abs(uEdge2 - outerCir.center.u);
				const dv1 = dx1 < outerCir.radius ? Math.sqrt(outerCir.radius * outerCir.radius - dx1 * dx1) : 0;
				const dv2 = dx2 < outerCir.radius ? Math.sqrt(outerCir.radius * outerCir.radius - dx2 * dx2) : 0;
				const vOuter1 = outerCir.center.v + dirV * dv1;
				const vOuter2 = outerCir.center.v + dirV * dv2;
				if (dirV === 1) return vEnd >= Math.min(vOuter1, vOuter2) - 3;
				else return vEnd <= Math.max(vOuter1, vOuter2) + 3;
			}
		}
		if (outerLoops.length === 0) return true;
		const lp = outerLoops[0];
		const stepV = vEnd + dirV * 4.5;
		const dCenter = curvedLoopSignedDist2D({
			u: uCenter,
			v: stepV
		}, lp.points, lp.segments);
		const dEdge1 = curvedLoopSignedDist2D({
			u: uEdge1,
			v: stepV
		}, lp.points, lp.segments);
		const dEdge2 = curvedLoopSignedDist2D({
			u: uEdge2,
			v: stepV
		}, lp.points, lp.segments);
		return dCenter > -.5 || dEdge1 > -.5 || dEdge2 > -.5;
	};
	const resolveBandCutSpan = (matchedBands, outerLoops, viewCircles, vB, uEdge1, uEdge2, boundMin, boundMax) => {
		const rawMin = Math.min(...matchedBands.map((b) => b.vMin));
		const rawMax = Math.max(...matchedBands.map((b) => b.vMax));
		const uMid = .5 * (uEdge1 + uEdge2);
		const reachesMinExt = matchedBands.some((b) => b.openMin) || isBandEndOnViewExterior(outerLoops, viewCircles, vB, uMid, uEdge1, uEdge2, rawMin, -1);
		const reachesMaxExt = matchedBands.some((b) => b.openMax) || isBandEndOnViewExterior(outerLoops, viewCircles, vB, uMid, uEdge1, uEdge2, rawMax, 1);
		let dMin = reachesMinExt ? boundMin - 2 : rawMin;
		let dMax = reachesMaxExt ? boundMax + 2 : rawMax;
		const innerCircles = viewCircles.filter((c) => !usedEntityIds.has(c.id));
		if (reachesMaxExt && !reachesMinExt && innerCircles.length > 0) for (const ic of innerCircles) {
			const dx1 = Math.abs(uEdge1 - ic.center.u);
			const dx2 = Math.abs(uEdge2 - ic.center.u);
			if (dx1 <= ic.radius + 1.5 || dx2 <= ic.radius + 1.5) {
				const dv = Math.sqrt(Math.max(0, ic.radius * ic.radius - Math.min(dx1, dx2) ** 2));
				if (rawMin <= ic.center.v + dv + 3 && rawMin >= ic.center.v - 2) dMin = Math.min(dMin, ic.center.v);
			}
		}
		else if (reachesMinExt && !reachesMaxExt && innerCircles.length > 0) for (const ic of innerCircles) {
			const dx1 = Math.abs(uEdge1 - ic.center.u);
			const dx2 = Math.abs(uEdge2 - ic.center.u);
			if (dx1 <= ic.radius + 1.5 || dx2 <= ic.radius + 1.5) {
				const dv = Math.sqrt(Math.max(0, ic.radius * ic.radius - Math.min(dx1, dx2) ** 2));
				if (rawMax >= ic.center.v - dv - 3 && rawMax <= ic.center.v + 2) dMax = Math.max(dMax, ic.center.v);
			}
		}
		return {
			dMin,
			dMax
		};
	};
	const isSpanMatchingOuterFlatEndOrStep = (view: "front" | "top" | "left", coordAxis: "u" | "v", s1: number, s2: number) => {
		const loops = view === "front" ? solidLoopsFront : view === "top" ? solidLoopsTop : solidLoopsLeft;
		for (const lp of loops) {
			for (const seg of lp.segments) {
				if (seg.kind !== "line" || !seg.p1 || !seg.p2) continue;
				if (coordAxis === "u" && Math.abs(seg.p1.v - seg.p2.v) <= 2.0) {
					const uMinSeg = Math.min(seg.p1.u, seg.p2.u);
					const uMaxSeg = Math.max(seg.p1.u, seg.p2.u);
					if (Math.abs(uMinSeg - s1) <= 3.0 && Math.abs(uMaxSeg - s2) <= 3.0) return true;
				}
				if (coordAxis === "v" && Math.abs(seg.p1.u - seg.p2.u) <= 2.0) {
					const vMinSeg = Math.min(seg.p1.v, seg.p2.v);
					const vMaxSeg = Math.max(seg.p1.v, seg.p2.v);
					if (Math.abs(vMinSeg - s1) <= 3.0 && Math.abs(vMaxSeg - s2) <= 3.0) return true;
				}
			}
		}
		return false;
	};
	[
		...circlesTop,
		...circlesFront,
		...circlesLeft
	].filter((c) => !usedEntityIds.has(c.id)).forEach((c, idx) => {
		if (c.view === "top") {
			const cX1 = c.center.u - c.radius;
			const cX2 = c.center.u + c.radius;
			const cY1 = c.center.v - c.radius;
			const cY2 = c.center.v + c.radius;
			let zStart = zMin - 2;
			let zEnd = zMax + 2;
			let hasExplicitDashedMatch = false;
			const matchedFrontBands = slotsFront.uBands.filter((b, bIdx) => {
				if (Math.abs(b.u1 - cX1) <= PAIR_TOL && Math.abs(b.u2 - cX2) <= PAIR_TOL) {
					usedFrontUBands.add(bIdx);
					return true;
				}
				return false;
			});
			const matchedFrontSlotIdx = slotsFront.uSlots.findIndex((s) => Math.abs(s.uMin - cX1) <= PAIR_TOL && Math.abs(s.uMax - cX2) <= PAIR_TOL);
			const matchedFrontSlot = matchedFrontSlotIdx !== -1 ? slotsFront.uSlots[matchedFrontSlotIdx] : void 0;
			if (matchedFrontSlotIdx !== -1) usedFrontUSlots.add(matchedFrontSlotIdx);
			const matchedLeftBands = slotsLeft.uBands.filter((b, bIdx) => {
				if (Math.abs(b.u1 - cY1) <= PAIR_TOL && Math.abs(b.u2 - cY2) <= PAIR_TOL) {
					usedLeftUBands.add(bIdx);
					return true;
				}
				return false;
			});
			const matchedLeftSlotIdx = slotsLeft.uSlots.findIndex((s) => Math.abs(s.uMin - cY1) <= PAIR_TOL && Math.abs(s.uMax - cY2) <= PAIR_TOL);
			const matchedLeftSlot = matchedLeftSlotIdx !== -1 ? slotsLeft.uSlots[matchedLeftSlotIdx] : void 0;
			if (matchedLeftSlotIdx !== -1) usedLeftUSlots.add(matchedLeftSlotIdx);
			if (matchedFrontSlot) {
				hasExplicitDashedMatch = true;
				zStart = matchedFrontSlot.openSide === "vMin" ? zMin - 2 : matchedFrontSlot.vMin;
				zEnd = matchedFrontSlot.openSide === "vMax" ? zMax + 2 : matchedFrontSlot.vMax;
			} else if (matchedLeftSlot) {
				hasExplicitDashedMatch = true;
				zStart = matchedLeftSlot.openSide === "vMin" ? zMin - 2 : matchedLeftSlot.vMin;
				zEnd = matchedLeftSlot.openSide === "vMax" ? zMax + 2 : matchedLeftSlot.vMax;
			} else if (matchedFrontBands.length > 0) {
				hasExplicitDashedMatch = true;
				const slantedBand: any = matchedFrontBands.find((b: any) => Array.isArray(b.slantedPoly) && b.slantedPoly.length >= 3);
				if (slantedBand) {
					pairedSubtracts.push({
						id: `sub-hole-z-slanted-${idx}`,
						featureId: c.featureId || `hole_z_${idx}`,
						label: `Slanted Hole Ø${Math.round(c.radius * 2)}`,
						operation: "subtract",
						shape: "prism",
						prismAxis: "Y",
						extrudeAxis: "y",
						prismPolygon: slantedBand.slantedPoly,
						polygon2D: slantedBand.slantedPoly,
						xMin: cX1,
						xMax: cX2,
						yMin: cY1,
						yMax: cY2,
						zMin: slantedBand.vMin,
						zMax: slantedBand.vMax <= zMax - 1.5 ? slantedBand.vMax : zMax + 2,
						isInternalFeature: true
					} as any);
					return;
				}
				const { dMin, dMax } = resolveBandCutSpan(matchedFrontBands, solidLoopsFront, circlesFront, bFront, cX1, cX2, zMin, zMax);
				zStart = dMin;
				zEnd = dMax;
			} else if (matchedLeftBands.length > 0) {
				hasExplicitDashedMatch = true;
				const slantedBand: any = matchedLeftBands.find((b: any) => Array.isArray(b.slantedPoly) && b.slantedPoly.length >= 3);
				if (slantedBand) {
					pairedSubtracts.push({
						id: `sub-hole-z-lslanted-${idx}`,
						featureId: c.featureId || `hole_z_${idx}`,
						label: `Slanted Hole Ø${Math.round(c.radius * 2)}`,
						operation: "subtract",
						shape: "prism",
						prismAxis: "X",
						extrudeAxis: "x",
						prismPolygon: slantedBand.slantedPoly,
						polygon2D: slantedBand.slantedPoly,
						xMin: cX1,
						xMax: cX2,
						yMin: cY1,
						yMax: cY2,
						zMin: slantedBand.vMin,
						zMax: slantedBand.vMax <= zMax - 1.5 ? slantedBand.vMax : zMax + 2,
						isInternalFeature: true
					} as any);
					return;
				}
				const { dMin, dMax } = resolveBandCutSpan(matchedLeftBands, solidLoopsLeft, circlesLeft, bLeft, cY1, cY2, zMin, zMax);
				zStart = dMin;
				zEnd = dMax;
			} else {
				const stepFront = slotsFront.singleHorizDashed.find((h: any) => h.isStepPlane && h.uMin <= cX1 + PAIR_TOL && h.uMax >= cX2 - PAIR_TOL && h.v > zMin + 1.5 && h.v < zMax - 1.5);
				const stepLeft = slotsLeft.singleHorizDashed.find((h: any) => h.isStepPlane && h.uMin <= cY1 + PAIR_TOL && h.uMax >= cY2 - PAIR_TOL && h.v > zMin + 1.5 && h.v < zMax - 1.5);
				const stepZ = stepFront ? stepFront.v : stepLeft ? stepLeft.v : void 0;
				if (stepZ !== void 0) {
					hasExplicitDashedMatch = true;
					if (zMax - stepZ <= stepZ - zMin) {
						zStart = stepZ;
						zEnd = zMax + 2;
					} else {
						zStart = zMin - 2;
						zEnd = stepZ;
					}
				}
			}
			// Rule 2.1: If no dashed lines match this solid circle and its span matches an outer flat base/step in the other view, never drill a false hole!
			if (!hasExplicitDashedMatch && c.lineType === "thick_solid") {
				if (isSpanMatchingOuterFlatEndOrStep("front", "u", cX1, cX2) || isSpanMatchingOuterFlatEndOrStep("left", "u", cY1, cY2)) {
					return;
				}
			}
			pairedSubtracts.push({
				id: `sub-hole-z-${idx}`,
				featureId: c.featureId || `hole_z_${idx}`,
				label: `Hole Ø${Math.round(c.radius * 2)}`,
				operation: "subtract",
				shape: "cylinder_z",
				xMin: cX1,
				xMax: cX2,
				yMin: cY1,
				yMax: cY2,
				zMin: zStart,
				zMax: zEnd,
				centerX: c.center.u,
				centerY: c.center.v,
				radius: c.radius,
				isInternalFeature: true
			});
		} else if (c.view === "front") {
			const cX1 = c.center.u - c.radius;
			const cX2 = c.center.u + c.radius;
			const cZ1 = c.center.v - c.radius;
			const cZ2 = c.center.v + c.radius;
			let yStart = yMin - 2;
			let yEnd = yMax + 2;
			let hasExplicitDashedMatch = false;
			const matchedTopSlotIdx = slotsTop.uSlots.findIndex((s) => Math.abs(s.uMin - cX1) <= PAIR_TOL && Math.abs(s.uMax - cX2) <= PAIR_TOL);
			const matchedTopSlot = matchedTopSlotIdx !== -1 ? slotsTop.uSlots[matchedTopSlotIdx] : void 0;
			if (matchedTopSlotIdx !== -1) usedTopUSlots.add(matchedTopSlotIdx);
			const matchedTopBands = slotsTop.uBands.filter((b, bIdx) => {
				if (Math.abs(b.u1 - cX1) <= PAIR_TOL && Math.abs(b.u2 - cX2) <= PAIR_TOL) {
					usedTopUBands.add(bIdx);
					return true;
				}
				return false;
			});
			const matchedLeftSlotIdx = slotsLeft.uSlots.findIndex((s) => Math.abs(s.vMin - cZ1) <= PAIR_TOL && Math.abs(s.vMax - cZ2) <= PAIR_TOL);
			const matchedLeftSlot = matchedLeftSlotIdx !== -1 ? slotsLeft.uSlots[matchedLeftSlotIdx] : void 0;
			if (matchedLeftSlotIdx !== -1) usedLeftUSlots.add(matchedLeftSlotIdx);
			const matchedLeftBands = slotsLeft.vBands.filter((b, bIdx) => {
				if (Math.abs(b.v1 - cZ1) <= PAIR_TOL && Math.abs(b.v2 - cZ2) <= PAIR_TOL) {
					usedLeftVBands.add(bIdx);
					return true;
				}
				return false;
			});
			if (matchedTopSlot) {
				hasExplicitDashedMatch = true;
				yStart = matchedTopSlot.openSide === "vMin" ? yMin - 2 : matchedTopSlot.vMin;
				yEnd = matchedTopSlot.openSide === "vMax" ? yMax + 2 : matchedTopSlot.vMax;
			} else if (matchedLeftSlot) {
				hasExplicitDashedMatch = true;
				yStart = matchedLeftSlot.openSide === "uMin" ? yMin - 2 : matchedLeftSlot.uMin;
				yEnd = matchedLeftSlot.openSide === "uMax" ? yMax + 2 : matchedLeftSlot.uMax;
			} else if (matchedTopBands.length > 0) {
				hasExplicitDashedMatch = true;
				const { dMin, dMax } = resolveBandCutSpan(matchedTopBands, solidLoopsTop, circlesTop, bTop, cX1, cX2, yMin, yMax);
				yStart = dMin;
				yEnd = dMax;
			} else if (matchedLeftBands.length > 0) {
				hasExplicitDashedMatch = true;
				const minU = Math.min(...matchedLeftBands.map((b) => b.uMin));
				const maxU = Math.max(...matchedLeftBands.map((b) => b.uMax));
				const openMin = matchedLeftBands.some((b: any) => b.openMin) || minU <= yMin + 2.5;
				const openMax = matchedLeftBands.some((b: any) => b.openMax) || maxU >= yMax - 2.5;
				yStart = openMin ? yMin - 2 : minU;
				yEnd = openMax ? yMax + 2 : maxU;
			} else {
				const stepTop = slotsTop.singleHorizDashed.find((h: any) => h.isStepPlane && h.uMin <= cX1 + PAIR_TOL && h.uMax >= cX2 - PAIR_TOL && h.v > yMin + 1.5 && h.v < yMax - 1.5);
				const stepLeft = slotsLeft.singleVertDashed.find((v: any) => v.isStepPlane && v.vMin <= cZ1 + PAIR_TOL && v.vMax >= cZ2 - PAIR_TOL && v.u > yMin + 1.5 && v.u < yMax - 1.5);
				const stepY = stepTop ? stepTop.v : stepLeft ? stepLeft.u : void 0;
				if (stepY !== void 0) {
					hasExplicitDashedMatch = true;
					if (yMax - stepY <= stepY - yMin) {
						yStart = stepY;
						yEnd = yMax + 2;
					} else {
						yStart = yMin - 2;
						yEnd = stepY;
					}
				}
			}
			if (!hasExplicitDashedMatch && c.lineType === "thick_solid") {
				if (isSpanMatchingOuterFlatEndOrStep("top", "u", cX1, cX2) || isSpanMatchingOuterFlatEndOrStep("left", "v", cZ1, cZ2)) {
					return;
				}
			}
			pairedSubtracts.push({
				id: `sub-hole-y-${idx}`,
				featureId: c.featureId || `hole_y_${idx}`,
				label: `Hole Ø${Math.round(c.radius * 2)}`,
				operation: "subtract",
				shape: "cylinder_y",
				xMin: cX1,
				xMax: cX2,
				yMin: yStart,
				yMax: yEnd,
				zMin: cZ1,
				zMax: cZ2,
				centerX: c.center.u,
				centerZ: c.center.v,
				radius: c.radius,
				isInternalFeature: true
			});
		} else if (c.view === "left") {
			const cY1 = c.center.u - c.radius;
			const cY2 = c.center.u + c.radius;
			const cZ1 = c.center.v - c.radius;
			const cZ2 = c.center.v + c.radius;
			let xStart = xMin - 2;
			let xEnd = xMax + 2;
			let hasExplicitDashedMatch = false;
			const matchedFrontSlotIdx = slotsFront.uSlots.findIndex((s) => Math.abs(s.vMin - cZ1) <= PAIR_TOL && Math.abs(s.vMax - cZ2) <= PAIR_TOL);
			const matchedFrontSlot = matchedFrontSlotIdx !== -1 ? slotsFront.uSlots[matchedFrontSlotIdx] : void 0;
			if (matchedFrontSlotIdx !== -1) usedFrontUSlots.add(matchedFrontSlotIdx);
			const matchedTopSlotIdx = slotsTop.uSlots.findIndex((s) => Math.abs(s.vMin - cY1) <= PAIR_TOL && Math.abs(s.vMax - cY2) <= PAIR_TOL);
			const matchedTopSlot = matchedTopSlotIdx !== -1 ? slotsTop.uSlots[matchedTopSlotIdx] : void 0;
			if (matchedTopSlotIdx !== -1) usedTopUSlots.add(matchedTopSlotIdx);
			const matchedFrontBands = slotsFront.vBands.filter((b, bIdx) => {
				if (Math.abs(b.v1 - cZ1) <= PAIR_TOL && Math.abs(b.v2 - cZ2) <= PAIR_TOL) {
					usedFrontVBands.add(bIdx);
					return true;
				}
				return false;
			});
			const matchedTopBands = slotsTop.vBands.filter((b, bIdx) => {
				if (Math.abs(b.v1 - cY1) <= PAIR_TOL && Math.abs(b.v2 - cY2) <= PAIR_TOL) {
					usedTopVBands.add(bIdx);
					return true;
				}
				return false;
			});
			if (matchedFrontSlot) {
				hasExplicitDashedMatch = true;
				xStart = matchedFrontSlot.openSide === "uMin" ? xMin - 2 : matchedFrontSlot.uMin;
				xEnd = matchedFrontSlot.openSide === "uMax" ? xMax + 2 : matchedFrontSlot.uMax;
			} else if (matchedTopSlot) {
				hasExplicitDashedMatch = true;
				xStart = matchedTopSlot.openSide === "uMin" ? xMin - 2 : matchedTopSlot.uMin;
				xEnd = matchedTopSlot.openSide === "uMax" ? xMax + 2 : matchedTopSlot.uMax;
			} else if (matchedFrontBands.length > 0) {
				hasExplicitDashedMatch = true;
				const minU = Math.min(...matchedFrontBands.map((b) => b.uMin));
				const maxU = Math.max(...matchedFrontBands.map((b) => b.uMax));
				const openMin = matchedFrontBands.some((b: any) => b.openMin) || minU <= xMin + 2.5;
				const openMax = matchedFrontBands.some((b: any) => b.openMax) || maxU >= xMax - 2.5;
				xStart = openMin ? xMin - 2 : minU;
				xEnd = openMax ? xMax + 2 : maxU;
			} else if (matchedTopBands.length > 0) {
				hasExplicitDashedMatch = true;
				const minU = Math.min(...matchedTopBands.map((b) => b.uMin));
				const maxU = Math.max(...matchedTopBands.map((b) => b.uMax));
				const openMin = matchedTopBands.some((b: any) => b.openMin) || minU <= xMin + 2.5;
				const openMax = matchedTopBands.some((b: any) => b.openMax) || maxU >= xMax - 2.5;
				xStart = openMin ? xMin - 2 : minU;
				xEnd = openMax ? xMax + 2 : maxU;
			} else {
				const stepFront = slotsFront.singleVertDashed.find((v: any) => v.isStepPlane && v.vMin <= cZ1 + PAIR_TOL && v.vMax >= cZ2 - PAIR_TOL && v.u > xMin + 1.5 && v.u < xMax - 1.5);
				const stepTop = slotsTop.singleVertDashed.find((v: any) => v.isStepPlane && v.vMin <= cY1 + PAIR_TOL && v.vMax >= cY2 - PAIR_TOL && v.u > xMin + 1.5 && v.u < xMax - 1.5);
				const stepX = stepFront ? stepFront.u : stepTop ? stepTop.u : void 0;
				if (stepX !== void 0) {
					hasExplicitDashedMatch = true;
					if (xMax - stepX <= stepX - xMin) {
						xStart = stepX;
						xEnd = xMax + 2;
					} else {
						xStart = xMin - 2;
						xEnd = stepX;
					}
				}
			}
			if (!hasExplicitDashedMatch && c.lineType === "thick_solid") {
				if (isSpanMatchingOuterFlatEndOrStep("front", "v", cZ1, cZ2) || isSpanMatchingOuterFlatEndOrStep("top", "v", cY1, cY2)) {
					return;
				}
			}
			pairedSubtracts.push({
				id: `sub-hole-x-${idx}`,
				featureId: c.featureId || `hole_x_${idx}`,
				label: `Hole Ø${Math.round(c.radius * 2)}`,
				operation: "subtract",
				shape: "cylinder_x",
				xMin: xStart,
				xMax: xEnd,
				yMin: cY1,
				yMax: cY2,
				zMin: cZ1,
				zMax: cZ2,
				centerY: c.center.u,
				centerZ: c.center.v,
				radius: c.radius,
				isInternalFeature: true
			});
		}
	});
	const dashedArcs = userEntities.filter((e) => e.type === "arc" && e.lineType === "thin_dashed" && !usedEntityIds.has(e.id));
	dashedArcs.forEach((arcEnt: any, idx) => {
		usedEntityIds.add(arcEnt.id);
		if (arcEnt.view === "top") {
			pairedSubtracts.push({
				id: `sub-darc-z-${idx}`,
				featureId: arcEnt.featureId || `darc_z_${idx}`,
				label: `Hidden Arc Cutout R${Math.round(arcEnt.radius)}`,
				operation: "subtract",
				shape: "cylinder_z",
				xMin: arcEnt.center.u - arcEnt.radius,
				xMax: arcEnt.center.u + arcEnt.radius,
				yMin: arcEnt.center.v - arcEnt.radius,
				yMax: arcEnt.center.v + arcEnt.radius,
				zMin: zMin - 2,
				zMax: zMax + 2,
				centerX: arcEnt.center.u,
				centerY: arcEnt.center.v,
				radius: arcEnt.radius,
				isInternalFeature: true
			});
		} else if (arcEnt.view === "front") {
			pairedSubtracts.push({
				id: `sub-darc-y-${idx}`,
				featureId: arcEnt.featureId || `darc_y_${idx}`,
				label: `Hidden Arc Cutout R${Math.round(arcEnt.radius)}`,
				operation: "subtract",
				shape: "cylinder_y",
				xMin: arcEnt.center.u - arcEnt.radius,
				xMax: arcEnt.center.u + arcEnt.radius,
				yMin: yMin - 2,
				yMax: yMax + 2,
				zMin: arcEnt.center.v - arcEnt.radius,
				zMax: arcEnt.center.v + arcEnt.radius,
				centerX: arcEnt.center.u,
				centerZ: arcEnt.center.v,
				radius: arcEnt.radius,
				isInternalFeature: true
			});
		} else if (arcEnt.view === "left") {
			pairedSubtracts.push({
				id: `sub-darc-x-${idx}`,
				featureId: arcEnt.featureId || `darc_x_${idx}`,
				label: `Hidden Arc Cutout R${Math.round(arcEnt.radius)}`,
				operation: "subtract",
				shape: "cylinder_x",
				xMin: xMin - 2,
				xMax: xMax + 2,
				yMin: arcEnt.center.u - arcEnt.radius,
				yMax: arcEnt.center.u + arcEnt.radius,
				zMin: arcEnt.center.v - arcEnt.radius,
				zMax: arcEnt.center.v + arcEnt.radius,
				centerY: arcEnt.center.u,
				centerZ: arcEnt.center.v,
				radius: arcEnt.radius,
				isInternalFeature: true
			});
		}
	});
	const makeLoopOrPrismSubtract = (view: "front" | "top" | "left", lp: any, id: string, featureId: string, label: string, x1: number, x2: number, y1: number, y2: number, z1: number, z2: number) => {
		const isSlanted = Boolean(lp.isSlantedPrism && Array.isArray(lp.points) && lp.points.length >= 3);
		const pAxis = view === "front" ? "Y" : view === "top" ? "Z" : "X";
		const eAxis = view === "front" ? "y" : view === "top" ? "z" : "x";
		return {
			id,
			featureId,
			label,
			operation: "subtract",
			shape: isSlanted ? "prism" : "box",
			prismAxis: isSlanted ? pAxis : void 0,
			extrudeAxis: isSlanted ? eAxis : void 0,
			prismPolygon: isSlanted ? lp.points : void 0,
			polygon2D: isSlanted ? lp.points : void 0,
			xMin: x1,
			xMax: x2,
			yMin: y1,
			yMax: y2,
			zMin: z1,
			zMax: z2,
			isInternalFeature: true
		};
	};
	innerLoopsFront.forEach((fLoop: any, idx) => {
		if (fLoop._vBandIdx !== void 0 && usedFrontVBands.has(fLoop._vBandIdx)) return;
		let matchedDepth = false;
		const padXMin = fLoop.uMin <= xMin + 1.5 ? xMin - 2 : fLoop.uMin;
		const padXMax = fLoop.uMax >= xMax - 1.5 ? xMax + 2 : fLoop.uMax;
		const padZMin = fLoop.vMin <= zMin + 1.5 ? zMin - 2 : fLoop.vMin;
		const padZMax = fLoop.vMax >= zMax - 1.5 ? zMax + 2 : fLoop.vMax;
		slotsTop.uSlots.forEach((tSlot, sIdx) => {
			if (Math.abs(tSlot.uMin - fLoop.uMin) <= PAIR_TOL && Math.abs(tSlot.uMax - fLoop.uMax) <= PAIR_TOL) {
				usedTopUSlots.add(sIdx);
				matchedDepth = true;
				if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"front",
					fLoop,
					`sub-front-slot-y-${idx}-${pairedSubtracts.length}`,
					`slot_fy_${idx}`,
					`Blind Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
					padXMin,
					padXMax,
					tSlot.openSide === "vMin" || tSlot.vMin <= yMin + 1.5 ? yMin - 2 : tSlot.vMin,
					tSlot.openSide === "vMax" || tSlot.vMax >= yMax - 1.5 ? yMax + 2 : tSlot.vMax,
					padZMin,
					padZMax
				));
			}
		});
		const matchedTopBands = slotsTop.uBands.filter((tBand, bIdx) => {
			if (usedTopUBands.has(bIdx)) return false;
			if (Math.abs(tBand.u1 - fLoop.uMin) <= PAIR_TOL && Math.abs(tBand.u2 - fLoop.uMax) <= PAIR_TOL) {
				usedTopUBands.add(bIdx);
				return true;
			}
			return false;
		});
		if (matchedTopBands.length > 0) {
			matchedDepth = true;
			if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
			const { dMin: slotYMin, dMax: slotYMax } = resolveBandCutSpan(matchedTopBands, solidLoopsTop, circlesTop, bTop, fLoop.uMin, fLoop.uMax, yMin, yMax);
			pairedSubtracts.push(makeLoopOrPrismSubtract(
				"front",
				fLoop,
				`sub-front-band-y-${idx}-${pairedSubtracts.length}`,
				`slot_fby_${idx}`,
				`Through Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
				padXMin,
				padXMax,
				slotYMin,
				slotYMax,
				padZMin,
				padZMax
			));
		}
		for (let bIdx = 0; bIdx < slotsTop.vBands.length; bIdx++) {
			if (usedTopVBands.has(bIdx)) continue;
			const tvBand = slotsTop.vBands[bIdx];
			if (Math.abs(tvBand.uMin - fLoop.uMin) <= PAIR_TOL && Math.abs(tvBand.uMax - fLoop.uMax) <= PAIR_TOL) {
				usedTopVBands.add(bIdx);
				matchedDepth = true;
				if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"front",
					fLoop,
					`sub-front-tvband-y-${idx}-${pairedSubtracts.length}`,
					`slot_ftvy_${idx}`,
					`Blind Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
					padXMin,
					padXMax,
					tvBand.v1 <= yMin + 1.5 ? yMin - 2 : tvBand.v1,
					tvBand.v2 >= yMax - 1.5 ? yMax + 2 : tvBand.v2,
					padZMin,
					padZMax
				));
			}
		}
		for (const tLoop of innerLoopsTop) if (Math.abs(tLoop.uMin - fLoop.uMin) <= PAIR_TOL && Math.abs(tLoop.uMax - fLoop.uMax) <= PAIR_TOL) {
			matchedDepth = true;
			if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
			pairedSubtracts.push(makeLoopOrPrismSubtract(
				"front",
				fLoop,
				`sub-front-loop-y-${idx}-${pairedSubtracts.length}`,
				`pocket_fy_${idx}`,
				`Pocket (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
				padXMin,
				padXMax,
				tLoop.vMin <= yMin + 1.5 ? yMin - 2 : tLoop.vMin,
				tLoop.vMax >= yMax - 1.5 ? yMax + 2 : tLoop.vMax,
				padZMin,
				padZMax
			));
		}
		if (!matchedDepth) {
			for (const hLine of slotsTop.singleHorizDashed) if ((Math.abs(hLine.uMin - fLoop.uMin) <= PAIR_TOL && Math.abs(hLine.uMax - fLoop.uMax) <= PAIR_TOL || (hLine as any).isStepPlane && hLine.uMin <= fLoop.uMin + PAIR_TOL && hLine.uMax >= fLoop.uMax - PAIR_TOL) && hLine.v > yMin + 1.5 && hLine.v < yMax - 1.5 && !matchesArcOnOuterLoop(solidLoopsFront, hLine.uMin, hLine.uMax, "u")) {
				matchedDepth = true;
				if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
				const cutFromBack = yMax - hLine.v < hLine.v - yMin;
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"front",
					fLoop,
					`sub-front-backwall-y-${idx}-${pairedSubtracts.length}`,
					`slot_fbw_${idx}`,
					`Blind Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
					padXMin,
					padXMax,
					cutFromBack ? hLine.v : yMin - 2,
					cutFromBack ? yMax + 2 : hLine.v,
					padZMin,
					padZMax
				));
				break;
			}
		}
		slotsLeft.uSlots.forEach((lSlot, sIdx) => {
			if (Math.abs(lSlot.vMin - fLoop.vMin) <= PAIR_TOL && Math.abs(lSlot.vMax - fLoop.vMax) <= PAIR_TOL) {
				usedLeftUSlots.add(sIdx);
				matchedDepth = true;
				if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"front",
					fLoop,
					`sub-front-slot-l-${idx}-${pairedSubtracts.length}`,
					`slot_fl_${idx}`,
					`Blind Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
					padXMin,
					padXMax,
					lSlot.uMin <= yMin + 1.5 ? yMin - 2 : lSlot.uMin,
					lSlot.uMax >= yMax - 1.5 ? yMax + 2 : lSlot.uMax,
					padZMin,
					padZMax
				));
			}
		});
		for (let bIdx = 0; bIdx < slotsLeft.vBands.length; bIdx++) {
			if (usedLeftVBands.has(bIdx)) continue;
			const lBand = slotsLeft.vBands[bIdx];
			if (Math.abs(lBand.v1 - fLoop.vMin) <= PAIR_TOL && Math.abs(lBand.v2 - fLoop.vMax) <= PAIR_TOL) {
				usedLeftVBands.add(bIdx);
				matchedDepth = true;
				if (fLoop._vBandIdx !== void 0) usedFrontVBands.add(fLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"front",
					fLoop,
					`sub-front-band-l-${idx}-${pairedSubtracts.length}`,
					`slot_fbl_${idx}`,
					`Slot (${Math.round(fLoop.uMax - fLoop.uMin)}×${Math.round(fLoop.vMax - fLoop.vMin)})`,
					padXMin,
					padXMax,
					lBand.uMin <= yMin + 2 ? yMin - 2 : lBand.uMin,
					lBand.uMax >= yMax - 2 ? yMax + 2 : lBand.uMax,
					padZMin,
					padZMax
				));
			}
		}
		const isFrontFullSpanRidge = fLoop.lineType === "thick_solid" && bFront && (
			Math.abs(fLoop.vMin - bFront.vMin) <= 1.8 && Math.abs(fLoop.vMax - bFront.vMax) <= 1.8 && (Math.abs(fLoop.uMin - bFront.uMin) <= 1.8 || Math.abs(fLoop.uMax - bFront.uMax) <= 1.8) ||
			Math.abs(fLoop.uMin - bFront.uMin) <= 1.8 && Math.abs(fLoop.uMax - bFront.uMax) <= 1.8 && (Math.abs(fLoop.vMin - bFront.vMin) <= 1.8 || Math.abs(fLoop.vMax - bFront.vMax) <= 1.8)
		);
		if (!matchedDepth && !isFrontFullSpanRidge) underConstrainedLoops.push({
			view: "front",
			loop: fLoop
		});
	});
	innerLoopsTop.forEach((tLoop: any, idx) => {
		if (tLoop._vBandIdx !== void 0 && usedTopVBands.has(tLoop._vBandIdx)) return;
		if (pairedSubtracts.some((p) => Math.abs(p.xMin - tLoop.uMin) <= PAIR_TOL && Math.abs(p.xMax - tLoop.uMax) <= PAIR_TOL && Math.abs(p.yMin - tLoop.vMin) <= PAIR_TOL && Math.abs(p.yMax - tLoop.vMax) <= PAIR_TOL)) return;
		let matchedDepth = false;
		const padXMin = tLoop.uMin <= xMin + 1.5 ? xMin - 2 : tLoop.uMin;
		const padXMax = tLoop.uMax >= xMax - 1.5 ? xMax + 2 : tLoop.uMax;
		const padYMin = tLoop.vMin <= yMin + 1.5 ? yMin - 2 : tLoop.vMin;
		const padYMax = tLoop.vMax >= yMax - 1.5 ? yMax + 2 : tLoop.vMax;
		slotsFront.uSlots.forEach((fSlot, sIdx) => {
			if (Math.abs(fSlot.uMin - tLoop.uMin) <= PAIR_TOL && Math.abs(fSlot.uMax - tLoop.uMax) <= PAIR_TOL) {
				usedFrontUSlots.add(sIdx);
				matchedDepth = true;
				if (tLoop._vBandIdx !== void 0) usedTopVBands.add(tLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"top",
					tLoop,
					`sub-top-slot-z-${idx}-${pairedSubtracts.length}`,
					`slot_tz_${idx}`,
					`Blind Pocket (${Math.round(tLoop.uMax - tLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
					padXMin,
					padXMax,
					padYMin,
					padYMax,
					fSlot.openSide === "vMin" ? zMin - 2 : fSlot.vMin,
					fSlot.openSide === "vMax" ? zMax + 2 : fSlot.vMax
				));
			}
		});
		const matchedFrontBands = slotsFront.uBands.filter((fBand, bIdx) => {
			if (usedFrontUBands.has(bIdx)) return false;
			if (Math.abs(fBand.u1 - tLoop.uMin) <= PAIR_TOL && Math.abs(fBand.u2 - tLoop.uMax) <= PAIR_TOL) {
				usedFrontUBands.add(bIdx);
				return true;
			}
			return false;
		});
		if (matchedFrontBands.length > 0) {
			matchedDepth = true;
			if (tLoop._vBandIdx !== void 0) usedTopVBands.add(tLoop._vBandIdx);
			const { dMin: slotZMin, dMax: slotZMax } = resolveBandCutSpan(matchedFrontBands, solidLoopsFront, circlesFront, bFront, tLoop.uMin, tLoop.uMax, zMin, zMax);
			pairedSubtracts.push(makeLoopOrPrismSubtract(
				"top",
				tLoop,
				`sub-top-band-z-${idx}-${pairedSubtracts.length}`,
				`slot_tbz_${idx}`,
				`Radial/Through Slot (${Math.round(tLoop.uMax - tLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
				padXMin,
				padXMax,
				padYMin,
				padYMax,
				slotZMin,
				slotZMax
			));
		}
		slotsLeft.uSlots.forEach((lSlot, sIdx) => {
			if (Math.abs(lSlot.uMin - tLoop.vMin) <= PAIR_TOL && Math.abs(lSlot.uMax - tLoop.vMax) <= PAIR_TOL) {
				usedLeftUSlots.add(sIdx);
				matchedDepth = true;
				if (tLoop._vBandIdx !== void 0) usedTopVBands.add(tLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"top",
					tLoop,
					`sub-top-lslot-z-${idx}-${pairedSubtracts.length}`,
					`slot_tlz_${idx}`,
					`Pocket (${Math.round(tLoop.uMax - tLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
					padXMin,
					padXMax,
					padYMin,
					padYMax,
					lSlot.openSide === "vMin" ? zMin - 2 : lSlot.vMin,
					lSlot.openSide === "vMax" ? zMax + 2 : lSlot.vMax
				));
			}
		});
		const matchedLeftBands = slotsLeft.uBands.filter((lBand, bIdx) => {
			if (usedLeftUBands.has(bIdx)) return false;
			if (Math.abs(lBand.u1 - tLoop.vMin) <= PAIR_TOL && Math.abs(lBand.u2 - tLoop.vMax) <= PAIR_TOL) {
				usedLeftUBands.add(bIdx);
				return true;
			}
			return false;
		});
		if (matchedLeftBands.length > 0) {
			matchedDepth = true;
			if (tLoop._vBandIdx !== void 0) usedTopVBands.add(tLoop._vBandIdx);
			const { dMin: slotZMin, dMax: slotZMax } = resolveBandCutSpan(matchedLeftBands, solidLoopsLeft, circlesLeft, bLeft, tLoop.vMin, tLoop.vMax, zMin, zMax);
			pairedSubtracts.push(makeLoopOrPrismSubtract(
				"top",
				tLoop,
				`sub-top-lband-z-${idx}-${pairedSubtracts.length}`,
				`slot_tlbz_${idx}`,
				`Slot (${Math.round(tLoop.uMax - tLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
				padXMin,
				padXMax,
				padYMin,
				padYMax,
				slotZMin,
				slotZMax
			));
		}
		if (!matchedDepth) {
			for (const hLine of slotsFront.singleHorizDashed) if ((Math.abs(hLine.uMin - tLoop.uMin) <= PAIR_TOL && Math.abs(hLine.uMax - tLoop.uMax) <= PAIR_TOL || (hLine as any).isStepPlane && hLine.uMin <= tLoop.uMin + PAIR_TOL && hLine.uMax >= tLoop.uMax - PAIR_TOL) && hLine.v > zMin + 1.5 && hLine.v < zMax - 1.5) {
				matchedDepth = true;
				if (tLoop._vBandIdx !== void 0) usedTopVBands.add(tLoop._vBandIdx);
				const cutFromTop = zMax - hLine.v <= hLine.v - zMin;
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"top",
					tLoop,
					`sub-top-step-z-${idx}-${pairedSubtracts.length}`,
					`slot_tsz_${idx}`,
					`Blind Slot (${Math.round(tLoop.uMax - tLoop.uMin)}×${Math.round(tLoop.vMax - tLoop.vMin)})`,
					padXMin,
					padXMax,
					padYMin,
					padYMax,
					cutFromTop ? hLine.v : zMin - 2,
					cutFromTop ? zMax + 2 : hLine.v
				));
				break;
			}
		}
		const isTopFullSpanRidge = tLoop.lineType === "thick_solid" && bTop && (
			Math.abs(tLoop.vMin - bTop.vMin) <= 1.8 && Math.abs(tLoop.vMax - bTop.vMax) <= 1.8 && (Math.abs(tLoop.uMin - bTop.uMin) <= 1.8 || Math.abs(tLoop.uMax - bTop.uMax) <= 1.8) ||
			Math.abs(tLoop.uMin - bTop.uMin) <= 1.8 && Math.abs(tLoop.uMax - bTop.uMax) <= 1.8 && (Math.abs(tLoop.vMin - bTop.vMin) <= 1.8 || Math.abs(tLoop.vMax - bTop.vMax) <= 1.8)
		);
		if (!matchedDepth && !isTopFullSpanRidge) underConstrainedLoops.push({
			view: "top",
			loop: tLoop
		});
	});
	innerLoopsLeft.forEach((lLoop: any, idx) => {
		if (lLoop._vBandIdx !== void 0 && usedLeftVBands.has(lLoop._vBandIdx)) return;
		if (pairedSubtracts.some((p) => Math.abs(p.yMin - lLoop.uMin) <= PAIR_TOL && Math.abs(p.yMax - lLoop.uMax) <= PAIR_TOL && Math.abs(p.zMin - lLoop.vMin) <= PAIR_TOL && Math.abs(p.zMax - lLoop.vMax) <= PAIR_TOL)) return;
		let matchedDepth = false;
		const padYMin = lLoop.uMin <= yMin + 1.5 ? yMin - 2 : lLoop.uMin;
		const padYMax = lLoop.uMax >= yMax - 1.5 ? yMax + 2 : lLoop.uMax;
		const padZMin = lLoop.vMin <= zMin + 1.5 ? zMin - 2 : lLoop.vMin;
		const padZMax = lLoop.vMax >= zMax - 1.5 ? zMax + 2 : lLoop.vMax;
		slotsFront.uSlots.forEach((fSlot, sIdx) => {
			if (Math.abs(fSlot.vMin - lLoop.vMin) <= PAIR_TOL && Math.abs(fSlot.vMax - lLoop.vMax) <= PAIR_TOL) {
				usedFrontUSlots.add(sIdx);
				matchedDepth = true;
				if (lLoop._vBandIdx !== void 0) usedLeftVBands.add(lLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"left",
					lLoop,
					`sub-left-slot-x-${idx}-${pairedSubtracts.length}`,
					`slot_lx_${idx}`,
					`Side Slot (${Math.round(lLoop.uMax - lLoop.uMin)}×${Math.round(lLoop.vMax - lLoop.vMin)})`,
					fSlot.uMin <= xMin + 1.5 ? xMin - 2 : fSlot.uMin,
					fSlot.uMax >= xMax - 1.5 ? xMax + 2 : fSlot.uMax,
					padYMin,
					padYMax,
					padZMin,
					padZMax
				));
			}
		});
		for (let bIdx = 0; bIdx < slotsFront.vBands.length; bIdx++) {
			if (usedFrontVBands.has(bIdx)) continue;
			const fBand = slotsFront.vBands[bIdx];
			if (Math.abs(fBand.v1 - lLoop.vMin) <= PAIR_TOL && Math.abs(fBand.v2 - lLoop.vMax) <= PAIR_TOL) {
				usedFrontVBands.add(bIdx);
				matchedDepth = true;
				if (lLoop._vBandIdx !== void 0) usedLeftVBands.add(lLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"left",
					lLoop,
					`sub-left-fband-x-${idx}-${pairedSubtracts.length}`,
					`slot_lfbx_${idx}`,
					`Side Slot (${Math.round(lLoop.uMax - lLoop.uMin)}×${Math.round(lLoop.vMax - lLoop.vMin)})`,
					fBand.uMin <= xMin + 2 ? xMin - 2 : fBand.uMin,
					fBand.uMax >= xMax - 2 ? xMax + 2 : fBand.uMax,
					padYMin,
					padYMax,
					padZMin,
					padZMax
				));
			}
		}
		slotsTop.uSlots.forEach((tSlot, sIdx) => {
			if (Math.abs(tSlot.vMin - lLoop.uMin) <= PAIR_TOL && Math.abs(tSlot.vMax - lLoop.uMax) <= PAIR_TOL) {
				usedTopUSlots.add(sIdx);
				matchedDepth = true;
				if (lLoop._vBandIdx !== void 0) usedLeftVBands.add(lLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"left",
					lLoop,
					`sub-left-tslot-x-${idx}-${pairedSubtracts.length}`,
					`slot_ltx_${idx}`,
					`Side Slot (${Math.round(lLoop.uMax - lLoop.uMin)}×${Math.round(lLoop.vMax - lLoop.vMin)})`,
					tSlot.uMin <= xMin + 1.5 ? xMin - 2 : tSlot.uMin,
					tSlot.uMax >= xMax - 1.5 ? xMax + 2 : tSlot.uMax,
					padYMin,
					padYMax,
					padZMin,
					padZMax
				));
			}
		});
		for (let bIdx = 0; bIdx < slotsTop.vBands.length; bIdx++) {
			if (usedTopVBands.has(bIdx)) continue;
			const tBand = slotsTop.vBands[bIdx];
			if (Math.abs(tBand.v1 - lLoop.uMin) <= PAIR_TOL && Math.abs(tBand.v2 - lLoop.uMax) <= PAIR_TOL) {
				usedTopVBands.add(bIdx);
				matchedDepth = true;
				if (lLoop._vBandIdx !== void 0) usedLeftVBands.add(lLoop._vBandIdx);
				pairedSubtracts.push(makeLoopOrPrismSubtract(
					"left",
					lLoop,
					`sub-left-tband-x-${idx}-${pairedSubtracts.length}`,
					`slot_ltbx_${idx}`,
					`Side Slot (${Math.round(lLoop.uMax - lLoop.uMin)}×${Math.round(lLoop.vMax - lLoop.vMin)})`,
					tBand.uMin <= xMin + 2 ? xMin - 2 : tBand.uMin,
					tBand.uMax >= xMax - 2 ? xMax + 2 : tBand.uMax,
					padYMin,
					padYMax,
					padZMin,
					padZMax
				));
			}
		}
		const isLeftFullSpanRidge = lLoop.lineType === "thick_solid" && bLeft && (
			Math.abs(lLoop.vMin - bLeft.vMin) <= 1.8 && Math.abs(lLoop.vMax - bLeft.vMax) <= 1.8 && (Math.abs(lLoop.uMin - bLeft.uMin) <= 1.8 || Math.abs(lLoop.uMax - bLeft.uMax) <= 1.8) ||
			Math.abs(lLoop.uMin - bLeft.uMin) <= 1.8 && Math.abs(lLoop.uMax - bLeft.uMax) <= 1.8 && (Math.abs(lLoop.vMin - bLeft.vMin) <= 1.8 || Math.abs(lLoop.vMax - bLeft.vMax) <= 1.8)
		);
		if (!matchedDepth && !isLeftFullSpanRidge) underConstrainedLoops.push({
			view: "left",
			loop: lLoop
		});
	});
	slotsFront.uSlots.forEach((fSlot, sIdx) => {
		if (usedFrontUSlots.has(sIdx)) return;
		const z1 = fSlot.openSide === "vMin" || fSlot.vMin <= zMin + 1.5 ? zMin - 2 : fSlot.vMin;
		const z2 = fSlot.openSide === "vMax" || fSlot.vMax >= zMax - 1.5 ? zMax + 2 : fSlot.vMax;
		const x1 = fSlot.openSide === "uMin" || fSlot.uMin <= xMin + 1.5 ? xMin - 2 : fSlot.uMin;
		const x2 = fSlot.openSide === "uMax" || fSlot.uMax >= xMax - 1.5 ? xMax + 2 : fSlot.uMax;
		pairedSubtracts.push({
			id: `sub-unpaired-fslot-${sIdx}`,
			featureId: `uslot_f_${sIdx}`,
			label: `Blind Slot (${Math.round(x2 - x1)}×${Math.round(z2 - z1)})`,
			operation: "subtract",
			shape: "box",
			xMin: x1,
			xMax: x2,
			yMin: yMin - 2,
			yMax: yMax + 2,
			zMin: z1,
			zMax: z2,
			isInternalFeature: true
		});
	});
	slotsTop.uSlots.forEach((tSlot, sIdx) => {
		if (usedTopUSlots.has(sIdx)) return;
		const y1 = tSlot.openSide === "vMin" || tSlot.vMin <= yMin + 1.5 ? yMin - 2 : tSlot.vMin;
		const y2 = tSlot.openSide === "vMax" || tSlot.vMax >= yMax - 1.5 ? yMax + 2 : tSlot.vMax;
		const x1 = tSlot.openSide === "uMin" || tSlot.uMin <= xMin + 1.5 ? xMin - 2 : tSlot.uMin;
		const x2 = tSlot.openSide === "uMax" || tSlot.uMax >= xMax - 1.5 ? xMax + 2 : tSlot.uMax;
		pairedSubtracts.push({
			id: `sub-unpaired-tslot-${sIdx}`,
			featureId: `uslot_t_${sIdx}`,
			label: `Blind Slot (${Math.round(x2 - x1)}×${Math.round(y2 - y1)})`,
			operation: "subtract",
			shape: "box",
			xMin: x1,
			xMax: x2,
			yMin: y1,
			yMax: y2,
			zMin: zMin - 2,
			zMax: zMax + 2,
			isInternalFeature: true
		});
	});
	slotsLeft.uSlots.forEach((lSlot, sIdx) => {
		if (usedLeftUSlots.has(sIdx)) return;
		const z1 = lSlot.openSide === "vMin" || lSlot.vMin <= zMin + 1.5 ? zMin - 2 : lSlot.vMin;
		const z2 = lSlot.openSide === "vMax" || lSlot.vMax >= zMax - 1.5 ? zMax + 2 : lSlot.vMax;
		const y1 = lSlot.openSide === "uMin" || lSlot.uMin <= yMin + 1.5 ? yMin - 2 : lSlot.uMin;
		const y2 = lSlot.openSide === "uMax" || lSlot.uMax >= yMax - 1.5 ? yMax + 2 : lSlot.uMax;
		pairedSubtracts.push({
			id: `sub-unpaired-lslot-${sIdx}`,
			featureId: `uslot_l_${sIdx}`,
			label: `Blind Slot (${Math.round(y2 - y1)}×${Math.round(z2 - z1)})`,
			operation: "subtract",
			shape: "box",
			xMin: xMin - 2,
			xMax: xMax + 2,
			yMin: y1,
			yMax: y2,
			zMin: z1,
			zMax: z2,
			isInternalFeature: true
		});
	});
	slotsFront.uBands.forEach((fBand: any, bIdx) => {
		if (usedFrontUBands.has(bIdx)) return;
		const { dMin: z1, dMax: z2 } = resolveBandCutSpan([fBand], solidLoopsFront, circlesFront, bFront, fBand.u1, fBand.u2, zMin, zMax);
		const lp = makeBandLoop(fBand.u1, fBand.u2, z1, z2, fBand.slantedPoly);
		pairedSubtracts.push(makeLoopOrPrismSubtract("front", lp, `sub-unpaired-fuband-${bIdx}`, `uband_f_${bIdx}`, `Through Slot (${Math.round(fBand.u2 - fBand.u1)})`, fBand.u1, fBand.u2, yMin - 2, yMax + 2, z1, z2));
	});
	slotsTop.uBands.forEach((tBand: any, bIdx) => {
		if (usedTopUBands.has(bIdx)) return;
		const { dMin: y1, dMax: y2 } = resolveBandCutSpan([tBand], solidLoopsTop, circlesTop, bTop, tBand.u1, tBand.u2, yMin, yMax);
		const lp = makeBandLoop(tBand.u1, tBand.u2, y1, y2, tBand.slantedPoly);
		pairedSubtracts.push(makeLoopOrPrismSubtract("top", lp, `sub-unpaired-tuband-${bIdx}`, `uband_t_${bIdx}`, `Through Slot (${Math.round(tBand.u2 - tBand.u1)})`, tBand.u1, tBand.u2, y1, y2, zMin - 2, zMax + 2));
	});
	slotsLeft.uBands.forEach((lBand: any, bIdx) => {
		if (usedLeftUBands.has(bIdx)) return;
		const { dMin: z1, dMax: z2 } = resolveBandCutSpan([lBand], solidLoopsLeft, circlesLeft, bLeft, lBand.u1, lBand.u2, zMin, zMax);
		const lp = makeBandLoop(lBand.u1, lBand.u2, z1, z2, lBand.slantedPoly);
		pairedSubtracts.push(makeLoopOrPrismSubtract("left", lp, `sub-unpaired-luband-${bIdx}`, `uband_l_${bIdx}`, `Through Slot (${Math.round(lBand.u2 - lBand.u1)})`, xMin - 2, xMax + 2, lBand.u1, lBand.u2, z1, z2));
	});
	// ============================================================================
	// Requirement 5: Runtime Self-Check & Self-Healing Engine (validateAndHealDerivation)
	// ============================================================================
	const validateAndHealDerivation = (rawPrims: Primitive3D[], rawDerived: any[]): { healedPrims: Primitive3D[]; healedEntities: any[] } => {
		let prims = [...rawPrims];
		const hasConeOrFrustum = prims.some((p) => p.operation === "add" && (p.shape === "cone_z" || p.shape === "cone_y" || p.shape === "cone_x" || p.shape === "pyramid"));
		const hasAnyDashedInKnownViews = userEntities.some((e) => (e.view === v1 || e.view === v2) && e.lineType === "thin_dashed");
		// Check 1: Intercept illegal through-holes when no dashed lines exist and the hole matches a frustum cap or outer flat step
		let removedIllegalHole = false;
		prims = prims.filter((p) => {
			if (p.operation !== "subtract") return true;
			if (p.id.startsWith("sub-hole-")) {
				if (hasConeOrFrustum && !hasAnyDashedInKnownViews) {
					removedIllegalHole = true;
					return false;
				}
				if (p.shape === "cylinder_z" && !slotsFront.uBands.some((b) => Math.abs(b.u1 - p.xMin) <= 3 && Math.abs(b.u2 - p.xMax) <= 3) && !slotsLeft.uBands.some((b) => Math.abs(b.u1 - p.yMin) <= 3 && Math.abs(b.u2 - p.yMax) <= 3) && (isSpanMatchingOuterFlatEndOrStep("front", "u", p.xMin, p.xMax) || isSpanMatchingOuterFlatEndOrStep("left", "u", p.yMin, p.yMax))) {
					removedIllegalHole = true;
					return false;
				}
				if (p.shape === "cylinder_y" && !slotsTop.uBands.some((b) => Math.abs(b.u1 - p.xMin) <= 3 && Math.abs(b.u2 - p.xMax) <= 3) && !slotsLeft.vBands.some((b) => Math.abs(b.v1 - p.zMin) <= 3 && Math.abs(b.v2 - p.zMax) <= 3) && (isSpanMatchingOuterFlatEndOrStep("top", "u", p.xMin, p.xMax) || isSpanMatchingOuterFlatEndOrStep("left", "v", p.zMin, p.zMax))) {
					removedIllegalHole = true;
					return false;
				}
				if (p.shape === "cylinder_x" && !slotsFront.vBands.some((b) => Math.abs(b.v1 - p.zMin) <= 3 && Math.abs(b.v2 - p.zMax) <= 3) && !slotsTop.vBands.some((b) => Math.abs(b.v1 - p.yMin) <= 3 && Math.abs(b.v2 - p.yMax) <= 3) && (isSpanMatchingOuterFlatEndOrStep("front", "v", p.zMin, p.zMax) || isSpanMatchingOuterFlatEndOrStep("top", "v", p.yMin, p.yMax))) {
					removedIllegalHole = true;
					return false;
				}
			}
			return true;
		});
		let derived = removedIllegalHole ? projectCSGSolidToView(targetView, prims, bounds) : [...rawDerived];

		// Check 2: Clean isolated micro thick_solid fragments (< 2.2mm) that dangle or touch collinear thin_dashed endpoints
		const solidLines = derived.filter((e) => e.type === "line" && e.lineType === "thick_solid");
		const dashedLines = derived.filter((e) => e.type === "line" && e.lineType === "thin_dashed");
		const solidCurvesAndArcs = derived.filter((e) => (e.type === "arc" || e.type === "circle" || e.type === "polygon") && e.lineType === "thick_solid");
		const isPtConnectedToSolid = (pt: Point2D, selfId: string) => {
			for (const sl of solidLines) {
				if (sl.id === selfId) continue;
				if (dist2D(pt, sl.p1) <= 0.65 || dist2D(pt, sl.p2) <= 0.65) return true;
			}
			for (const sc of solidCurvesAndArcs) {
				if (sc.type === "arc" && sc.center && sc.radius !== void 0) {
					if (Math.abs(dist2D(pt, sc.center) - sc.radius) <= 0.75) return true;
				} else if (sc.type === "circle" && sc.center && sc.radius !== void 0) {
					if (Math.abs(dist2D(pt, sc.center) - sc.radius) <= 0.75) return true;
				} else if (sc.type === "polygon" && Array.isArray(sc.points)) {
					if (sc.points.some((qp) => dist2D(pt, qp) <= 0.75)) return true;
				}
			}
			return false;
		};
		const toRemoveIds = new Set<string>();
		for (const sl of solidLines) {
			const len = dist2D(sl.p1, sl.p2);
			if (len >= 2.2) continue;
			const dxS = (sl.p2.u - sl.p1.u) / Math.max(1e-4, len);
			const dyS = (sl.p2.v - sl.p1.v) / Math.max(1e-4, len);
			// Check if touching a collinear thin_dashed line endpoint
			let mergedIntoDashed = false;
			for (const dl of dashedLines) {
				const dLen = dist2D(dl.p1, dl.p2);
				if (dLen < 0.5) continue;
				const dxD = (dl.p2.u - dl.p1.u) / dLen;
				const dyD = (dl.p2.v - dl.p1.v) / dLen;
				if (Math.abs(dxS * dxD + dyS * dyD) >= 0.985) {
					if (dist2D(sl.p1, dl.p1) <= 0.65) {
						dl.p1 = { ...sl.p2 };
						mergedIntoDashed = true;
						break;
					}
					if (dist2D(sl.p2, dl.p1) <= 0.65) {
						dl.p1 = { ...sl.p1 };
						mergedIntoDashed = true;
						break;
					}
					if (dist2D(sl.p1, dl.p2) <= 0.65) {
						dl.p2 = { ...sl.p2 };
						mergedIntoDashed = true;
						break;
					}
					if (dist2D(sl.p2, dl.p2) <= 0.65) {
						dl.p2 = { ...sl.p1 };
						mergedIntoDashed = true;
						break;
					}
				}
			}
			if (mergedIntoDashed) {
				toRemoveIds.add(sl.id);
				continue;
			}
			const c1 = isPtConnectedToSolid(sl.p1, sl.id);
			const c2 = isPtConnectedToSolid(sl.p2, sl.id);
			if (!c1 || !c2) {
				toRemoveIds.add(sl.id);
			}
		}
		if (toRemoveIds.size > 0) {
			derived = derived.filter((e) => !toRemoveIds.has(e.id));
		}

		// Check 3: Outer contour flat-base closure verification
		const remainingSolids = derived.filter((e) => e.lineType === "thick_solid");
		if (remainingSolids.length > 0 && !remainingSolids.some((e) => e.type === "circle")) {
			const endPts: Point2D[] = [];
			for (const e of remainingSolids) {
				if (e.type === "line") {
					endPts.push(e.p1, e.p2);
				} else if (e.type === "arc" && e.center && e.radius !== void 0 && e.startAngle !== void 0 && e.endAngle !== void 0) {
					endPts.push(
						{ u: e.center.u + e.radius * Math.cos(e.startAngle), v: e.center.v + e.radius * Math.sin(e.startAngle) },
						{ u: e.center.u + e.radius * Math.cos(e.endAngle), v: e.center.v + e.radius * Math.sin(e.endAngle) }
					);
				}
			}
			const danglingPts = endPts.filter((pt) => endPts.filter((other) => dist2D(pt, other) <= 0.75).length === 1);
			if (danglingPts.length === 2) {
				const [pA, pB] = danglingPts;
				if ((Math.abs(pA.u - pB.u) <= 0.8 || Math.abs(pA.v - pB.v) <= 0.8) && dist2D(pA, pB) >= 1.5) {
					derived.push({
						id: `derived-${targetView}-healed-base-${derived.length}`,
						view: targetView,
						type: "line",
						lineType: "thick_solid",
						p1: { u: Number(pA.u.toFixed(2)), v: Number(pA.v.toFixed(2)) },
						p2: { u: Number(pB.u.toFixed(2)), v: Number(pB.v.toFixed(2)) },
						source: "derived",
						featureId: "custom_main"
					} as any);
				}
			}
		}

		return { healedPrims: prims, healedEntities: derived };
	};

	const buildSolution = (id, title, subtitle, description, extraPrims) => {
		const rawPrims = [
			...basePrimitives,
			...pairedSubtracts,
			...extraPrims
		];
		const clonedPrims = JSON.parse(JSON.stringify(rawPrims));
		const rawDerived = projectCSGSolidToView(targetView, clonedPrims, bounds);
		const { healedPrims, healedEntities } = validateAndHealDerivation(clonedPrims, rawDerived);
		return {
			id,
			title,
			subtitle,
			description,
			confidence: "CSG",
			primitives3D: healedPrims,
			derivedEntities: healedEntities,
			projectionSteps: []
		};
	};
	if (underConstrainedLoops.length > 0) {
		const resolvePairedSpanForLoop = (view, loop) => {
			if (view === "front") {
				const matchedCir = circlesTop.find((c) => c.center.u + c.radius >= loop.uMin - PAIR_TOL && c.center.u - c.radius <= loop.uMax + PAIR_TOL);
				if (matchedCir) return {
					w1: matchedCir.center.v - matchedCir.radius,
					w2: matchedCir.center.v + matchedCir.radius
				};
				const matchedSub = pairedSubtracts.find((p) => p.xMax >= loop.uMin - PAIR_TOL && p.xMin <= loop.uMax + PAIR_TOL && p.yMin > yMin + 1 && p.yMax < yMax - 1);
				if (matchedSub) return {
					w1: matchedSub.yMin,
					w2: matchedSub.yMax
				};
				const midY = .5 * (yMin + yMax);
				const halfSpan = Math.min(.5 * (loop.vMax - loop.vMin), .3 * (yMax - yMin));
				return {
					w1: Number((midY - halfSpan).toFixed(1)),
					w2: Number((midY + halfSpan).toFixed(1))
				};
			}
			if (view === "top") {
				const matchedCir = circlesFront.find((c) => c.center.u + c.radius >= loop.uMin - PAIR_TOL && c.center.u - c.radius <= loop.uMax + PAIR_TOL);
				if (matchedCir) return {
					w1: matchedCir.center.v - matchedCir.radius,
					w2: matchedCir.center.v + matchedCir.radius
				};
				const matchedSub = pairedSubtracts.find((p) => p.xMax >= loop.uMin - PAIR_TOL && p.xMin <= loop.uMax + PAIR_TOL && p.zMin > zMin + 1 && p.zMax < zMax - 1);
				if (matchedSub) return {
					w1: matchedSub.zMin,
					w2: matchedSub.zMax
				};
				const midZ = .5 * (zMin + zMax);
				const halfSpan = Math.min(.5 * (loop.vMax - loop.vMin), .3 * (zMax - zMin));
				return {
					w1: Number((midZ - halfSpan).toFixed(1)),
					w2: Number((midZ + halfSpan).toFixed(1))
				};
			}
			const matchedCir = circlesTop.find((c) => c.center.v + c.radius >= loop.uMin - PAIR_TOL && c.center.v - c.radius <= loop.uMax + PAIR_TOL);
			if (matchedCir) return {
				w1: matchedCir.center.u - matchedCir.radius,
				w2: matchedCir.center.u + matchedCir.radius
			};
			const midX = .5 * (xMin + xMax);
			const halfSpan = Math.min(.5 * (loop.vMax - loop.vMin), .3 * (xMax - xMin));
			return {
				w1: Number((midX - halfSpan).toFixed(1)),
				w2: Number((midX + halfSpan).toFixed(1))
			};
		};
		const makeLoopSubtractPrim = (view, loop, wStart, wEnd, idPrefix, label) => {
			const padU1 = view === "left" ? loop.uMin <= yMin + 1.5 ? yMin - 2 : loop.uMin : loop.uMin <= xMin + 1.5 ? xMin - 2 : loop.uMin;
			const padU2 = view === "left" ? loop.uMax >= yMax - 1.5 ? yMax + 2 : loop.uMax : loop.uMax >= xMax - 1.5 ? xMax + 2 : loop.uMax;
			const padV1 = view === "top" ? loop.vMin <= yMin + 1.5 ? yMin - 2 : loop.vMin : loop.vMin <= zMin + 1.5 ? zMin - 2 : loop.vMin;
			const padV2 = view === "top" ? loop.vMax >= yMax - 1.5 ? yMax + 2 : loop.vMax : loop.vMax >= zMax - 1.5 ? zMax + 2 : loop.vMax;
			return makeLoopOrPrismSubtract(
				view,
				loop,
				`sub-${idPrefix}`,
				idPrefix,
				label,
				view === "left" ? wStart : padU1,
				view === "left" ? wEnd : padU2,
				view === "front" ? wStart : view === "top" ? padV1 : padU1,
				view === "front" ? wEnd : view === "top" ? padV2 : padU2,
				view === "top" ? wStart : padV1,
				view === "top" ? wEnd : padV2
			);
		};
		const pairedSpanPrims = underConstrainedLoops.map(({ view, loop }, i) => {
			const { w1, w2 } = resolvePairedSpanForLoop(view, loop);
			return makeLoopSubtractPrim(view, loop, w1, w2, `uc_paired_${i}`, "L-Bend / Paired-Span Channel");
		});
		const throughPrims = underConstrainedLoops.map(({ view, loop }, i) => {
			const wStart = view === "front" ? yMin - 2 : view === "top" ? zMin - 2 : xMin - 2;
			const wEnd = view === "front" ? yMax + 2 : view === "top" ? zMax + 2 : xMax + 2;
			return makeLoopSubtractPrim(view, loop, wStart, wEnd, `uc_through_${i}`, "Through Cutout");
		});
		const blindPrims = underConstrainedLoops.map(({ view, loop }, i) => {
			const wStart = view === "front" ? yMin - 2 : view === "top" ? Number((.5 * (zMin + zMax)).toFixed(1)) : xMin - 2;
			const wEnd = view === "front" ? Number((.5 * (yMin + yMax)).toFixed(1)) : view === "top" ? zMax + 2 : Number((.5 * (xMin + xMax)).toFixed(1));
			return makeLoopSubtractPrim(view, loop, wStart, wEnd, `uc_blind_${i}`, "Front Half-Depth Blind Slot");
		});
		return [
			buildSolution("sol_uc_paired", "候选解 1：L型折弯孔 / 等宽对穿孔", "配对跨度内腔特征 (Paired-Span Channel)", "内部虚线通道在深度方向严格对齐相邻视图配对圆/槽跨度 [w1, w2]，形成 L 型折弯孔或等宽内腔。", pairedSpanPrims),
			buildSolution("sol_uc_through", "候选解 2：全贯通槽 + 盲/通孔", "全贯通除料特征 (Full Through Slot)", "未配对的水平/竖直虚线特征贯穿整个基体深度 [wMin, wMax]，与配对孔特征执行布尔求差与消隐。", throughPrims),
			buildSolution("sol_uc_blind", "候选解 3：前壁半深盲槽 / 台阶孔", "半深盲槽除料特征 (Half-Depth Blind Slot)", "未配对的虚线特征从前表面切入基体一半深度 [wMin, wMid]，形成前壁半深盲槽或台阶盲腔。", blindPrims)
		];
	}
	return [buildSolution("sol_custom_csg", "CSG 严密三维实体解", "SDF-CSG 布尔求交与光线投射消隐", "基于跨视图特征配对、精确 SDF 布尔求差与三维视线 Raycast HLR 消隐生成。", [])];
}
/**
* Three-View Legitimacy, 3D Re-Projection Diffing & Under-Constrained Diagnostic Engine
* Supports full trilingual localization (zh-CN | zh-TW | en) & per-issue topological auto-fix payloads!
*/
export function diagnoseThreeViews(entities, knownViews, lang = "zh-CN") {
	const issues = [];
	const userEntities = entities.filter((e) => e.source !== "derived");
	const bFront = getViewBounds(userEntities, "front");
	const bTop = getViewBounds(userEntities, "top");
	const bLeft = getViewBounds(userEntities, "left");
	const TOLERANCE = 1.5;
	const viewName = (v) => {
		if (lang === "en") return v === "front" ? "Front View" : v === "top" ? "Top View" : "Left View";
		if (lang === "zh-TW") return v === "front" ? "主視圖" : v === "top" ? "俯視圖" : "左視圖";
		return v === "front" ? "主视图" : v === "top" ? "俯视图" : "左视图";
	};
	const activeViewCount = [
		bFront,
		bTop,
		bLeft
	].filter(Boolean).length;
	if (activeViewCount < 2) {
		issues.push({
			id: "diag-insufficient-views",
			severity: "error",
			category: "unclosed_loop",
			title: lang === "en" ? `Insufficient Views (${activeViewCount} active view(s) drawn)` : lang === "zh-TW" ? `視圖數量不足（目前僅 ${activeViewCount} 個視圖有圖元）` : `视图数量不足（当前仅 ${activeViewCount} 个视图有图元）`,
			description: lang === "en" ? "At least two views must contain valid closed contours (\"Know Two, Derive Third\") before 3D reconstruction or projection can be performed." : lang === "zh-TW" ? "工程製圖「知二求三」推導與校驗至少需要在兩個視圖中繪製有效閉合輪廓，空白或單一視圖無法唯一確定三維實體。" : "工程制图“知二求三”推导与校验至少需要在两个视图中绘制有效闭合轮廓，空白或单一视图无法唯一确定三维实体。",
			suggestion: lang === "en" ? "Draw closed contours in at least two views (e.g., Front View and Top View) with aligned X/Y/Z coordinates." : lang === "zh-TW" ? "請先在至少兩個視圖（如主視圖與俯視圖）中繪製對齊的閉合輪廓後再執行推導。" : "请先在至少两个视图（如主视图与俯视图）中绘制对齐的闭合轮廓后再执行推导。",
			views: [
				"front",
				"top",
				"left"
			]
		});
		return issues;
	}
	if (bFront && bTop) {
		const dMinX = Math.abs(bFront.uMin - bTop.uMin);
		const dMaxX = Math.abs(bFront.uMax - bTop.uMax);
		if (dMinX > TOLERANCE || dMaxX > TOLERANCE) {
			const badXFront = dMaxX > dMinX ? bFront.uMax : bFront.uMin;
			const badXTop = dMaxX > dMinX ? bTop.uMax : bTop.uMin;
			const delta = Number(Math.abs(badXFront - badXTop).toFixed(1));
			issues.push({
				id: "diag-len-mismatch",
				severity: "error",
				category: "violation_length",
				title: lang === "en" ? `X-Axis Misalignment: ΔX = ${delta}` : lang === "zh-TW" ? `X 軸向座標未對齊：ΔX = ${delta}` : `X 轴向坐标未对齐：ΔX = ${delta}`,
				description: lang === "en" ? `Front View X = ${badXFront} does not align with Top View X = ${badXTop}.` : lang === "zh-TW" ? `主視圖 X = ${badXFront} 與俯視圖 X = ${badXTop} 存在偏差。` : `主视图 X = ${badXFront} 与俯视图 X = ${badXTop} 存在偏差。`,
				suggestion: lang === "en" ? `Adjust Top View X boundary to X = ${badXFront}.` : lang === "zh-TW" ? `將俯視圖 X 邊界調整至 X = ${badXFront}。` : `将俯视图 X 边界调整至 X = ${badXFront}。`,
				views: ["front", "top"],
				fixPayload: {
					type: "align_axis",
					targetView: "top",
					axis: "X",
					coordKey: "u",
					actualVal: badXTop,
					expectedVal: badXFront
				},
				highlightCoords: [{
					view: "front",
					p1: {
						u: badXFront,
						v: bFront.vMin
					},
					p2: {
						u: badXFront,
						v: bFront.vMax
					},
					deltaValue: delta,
					axis: "X"
				}, {
					view: "top",
					p1: {
						u: badXTop,
						v: bTop.vMin
					},
					p2: {
						u: badXTop,
						v: bTop.vMax
					},
					deltaValue: delta,
					axis: "X"
				}]
			});
		}
	}
	if (bFront && bLeft) {
		const dMinZ = Math.abs(bFront.vMin - bLeft.vMin);
		const dMaxZ = Math.abs(bFront.vMax - bLeft.vMax);
		if (dMinZ > TOLERANCE || dMaxZ > TOLERANCE) {
			const badZFront = dMaxZ > dMinZ ? bFront.vMax : bFront.vMin;
			const badZLeft = dMaxZ > dMinZ ? bLeft.vMax : bLeft.vMin;
			const delta = Number(Math.abs(badZFront - badZLeft).toFixed(1));
			issues.push({
				id: "diag-height-mismatch",
				severity: "error",
				category: "violation_height",
				title: lang === "en" ? `Z-Axis Misalignment: ΔZ = ${delta}` : lang === "zh-TW" ? `Z 軸向座標未對齊：ΔZ = ${delta}` : `Z 轴向坐标未对齐：ΔZ = ${delta}`,
				description: lang === "en" ? `Front View Z = ${badZFront} does not align with Left View Z = ${badZLeft}.` : lang === "zh-TW" ? `主視圖 Z = ${badZFront} 與左視圖 Z = ${badZLeft} 存在偏差。` : `主视图 Z = ${badZFront} 与左视图 Z = ${badZLeft} 存在偏差。`,
				suggestion: lang === "en" ? `Adjust Left View Z boundary to Z = ${badZFront}.` : lang === "zh-TW" ? `將左視圖 Z 邊界修正至 Z = ${badZFront}。` : `将左视图 Z 边界修正至 Z = ${badZFront}。`,
				views: ["front", "left"],
				fixPayload: {
					type: "align_axis",
					targetView: "left",
					axis: "Z",
					coordKey: "v",
					actualVal: badZLeft,
					expectedVal: badZFront
				},
				highlightCoords: [{
					view: "front",
					p1: {
						u: bFront.uMin,
						v: badZFront
					},
					p2: {
						u: bFront.uMax,
						v: badZFront
					},
					deltaValue: delta,
					axis: "Z"
				}, {
					view: "left",
					p1: {
						u: bLeft.uMin,
						v: badZLeft
					},
					p2: {
						u: bLeft.uMax,
						v: badZLeft
					},
					deltaValue: delta,
					axis: "Z"
				}]
			});
		}
	}
	if (bTop && bLeft) {
		const dMinY = Math.abs(bTop.vMin - bLeft.uMin);
		const dMaxY = Math.abs(bTop.vMax - bLeft.uMax);
		if (dMinY > TOLERANCE || dMaxY > TOLERANCE) {
			const badYTop = dMaxY > dMinY ? bTop.vMax : bTop.vMin;
			const badYLeft = dMaxY > dMinY ? bLeft.uMax : bLeft.uMin;
			const delta = Number(Math.abs(badYTop - badYLeft).toFixed(1));
			issues.push({
				id: "diag-width-mismatch",
				severity: "error",
				category: "violation_width",
				title: lang === "en" ? `Y-Axis Misalignment: ΔY = ${delta}` : lang === "zh-TW" ? `Y 軸向座標未對齊：ΔY = ${delta}` : `Y 轴向坐标未对齐：ΔY = ${delta}`,
				description: lang === "en" ? `Top View Y = ${badYTop} does not align with Left View Y = ${badYLeft}.` : lang === "zh-TW" ? `俯視圖 Y = ${badYTop} 與左視圖 Y = ${badYLeft} 存在偏差。` : `俯视图 Y = ${badYTop} 与左视图 Y = ${badYLeft} 存在偏差。`,
				suggestion: lang === "en" ? `Adjust Left View Y boundary to Y = ${badYTop}.` : lang === "zh-TW" ? `將左視圖 Y 邊界調整為 Y = ${badYTop}。` : `将左视图 Y 边界调整为 Y = ${badYTop}。`,
				views: ["top", "left"],
				fixPayload: {
					type: "align_axis",
					targetView: "left",
					axis: "Y",
					coordKey: "u",
					actualVal: badYLeft,
					expectedVal: badYTop
				},
				highlightCoords: [{
					view: "top",
					p1: {
						u: bTop.uMin,
						v: badYTop
					},
					p2: {
						u: bTop.uMax,
						v: badYTop
					},
					deltaValue: delta,
					axis: "Y"
				}, {
					view: "left",
					p1: {
						u: badYLeft,
						v: bLeft.vMin
					},
					p2: {
						u: badYLeft,
						v: bLeft.vMax
					},
					deltaValue: delta,
					axis: "Y"
				}]
			});
		}
	}
	for (const view of [
		"front",
		"top",
		"left"
	]) {
		const solidLines = userEntities.filter((e) => e.view === view && e.lineType === "thick_solid" && e.type === "line");
		const allSegs = userEntities.filter((e) => e.view === view && e.lineType === "thick_solid").flatMap((e) => expandEntityToSegments(e));
		for (const ln of solidLines) for (const epKey of ["p1", "p2"]) {
			const ep = ln[epKey];
			let connected = false;
			let nearestPt = null;
			let minD = Infinity;
			for (const s of allSegs) {
				if (s.entityId === ln.id) continue;
				const { dist, proj } = pointToSegmentDist(ep, s.p1, s.p2);
				if (dist <= 1.2) {
					connected = true;
					break;
				}
				if (dist < minD) {
					minD = dist;
					nearestPt = proj;
				}
			}
			if (!connected) {
				issues.push({
					id: `diag-dangling-${ln.id}`,
					severity: "error",
					category: "unclosed_loop",
					title: lang === "en" ? `Unclosed Endpoint (${ep.u}, ${ep.v}) in ${viewName(view)}` : lang === "zh-TW" ? `${viewName(view)}未閉合懸空端點 (${ep.u}, ${ep.v})` : `${viewName(view)}未闭合悬空端点 (${ep.u}, ${ep.v})`,
					description: lang === "en" ? `Segment endpoint (${ep.u}, ${ep.v}) is not closed against adjacent geometry.` : lang === "zh-TW" ? `檢測到線段端點 (${ep.u}, ${ep.v}) 未與相鄰圖元閉合。` : `检测到线段端点 (${ep.u}, ${ep.v}) 未与相邻图元闭合。`,
					suggestion: lang === "en" ? `Extend or snap the endpoint to close the contour loop.` : lang === "zh-TW" ? `使用延伸 [E] 或自動修復閉合輪廓。` : `使用延伸 [E] 或自动修复闭合轮廓。`,
					views: [view],
					fixPayload: nearestPt ? {
						type: "close_dangling",
						targetView: view,
						danglingEntityId: ln.id,
						danglingEndpoint: epKey,
						snapTargetPt: nearestPt
					} : void 0,
					highlightCoords: [{
						view,
						p1: ln.p1,
						p2: ln.p2
					}]
				});
				break;
			}
		}
	}
	const targetView = [
		"front",
		"top",
		"left"
	].find((v) => !knownViews.includes(v)) || "left";
	const reconstructedSols = deriveFromCustomViews(userEntities, knownViews, targetView);
	if (reconstructedSols.length > 0) {
		const primarySol = reconstructedSols[0];
		const xSource = bFront || bTop;
		const zSource = bFront || bLeft;
		const ySource = bTop ? {
			min: bTop.vMin,
			max: bTop.vMax
		} : bLeft ? {
			min: bLeft.uMin,
			max: bLeft.uMax
		} : null;
		if (xSource && ySource && zSource) {
			const bounds = {
				xMin: xSource.uMin,
				xMax: xSource.uMax,
				yMin: ySource.min,
				yMax: ySource.max,
				zMin: zSource.vMin,
				zMax: zSource.vMax
			};
			for (const kv of knownViews) {
				const stdViewEnts = projectCSGSolidToView(kv, primarySol.primitives3D, bounds);
				const userCircles = userEntities.filter((e) => e.view === kv && e.type === "circle");
				for (const uc of userCircles) {
					const stdCir = stdViewEnts.find((se) => se.type === "circle" && dist2D(se.center, uc.center) <= 1.5 && Math.abs(se.radius - uc.radius) <= 1.5);
					if (stdCir && stdCir.lineType !== uc.lineType) issues.push({
						id: `diag-circle-lt-${uc.id}`,
						severity: "error",
						category: "hidden_conflict",
						title: lang === "en" ? `Wrong Line Type on Circle Ø${Math.round(uc.radius * 2)} in ${viewName(kv)}` : lang === "zh-TW" ? `${viewName(kv)}圓孔 Ø${Math.round(uc.radius * 2)} 虛實線型錯誤` : `${viewName(kv)}圆孔 Ø${Math.round(uc.radius * 2)} 虚实线型错误`,
						description: lang === "en" ? `According to 3D raycast occlusion, circle at (${uc.center.u}, ${uc.center.v}) has no front occlusion and must be drawn as ${stdCir.lineType}.` : lang === "zh-TW" ? `經 3D 視線遮擋檢測，位於 (${uc.center.u}, ${uc.center.v}) 的圓孔在頂面無遮擋，應繪製為粗實線（thick_solid），而非細虛線。` : `经 3D 视线遮挡检测，位于 (${uc.center.u}, ${uc.center.v}) 的圆孔在顶面无遮挡，应绘制为粗实线（thick_solid），而非细虚线。`,
						suggestion: lang === "en" ? `Convert circle Ø${Math.round(uc.radius * 2)} to ${stdCir.lineType}.` : lang === "zh-TW" ? `一鍵將該圓孔轉換為標準粗實線。` : `一键将该圆孔转换为标准粗实线。`,
						views: [kv],
						fixPayload: {
							type: "convert_linetype",
							targetView: kv,
							entityId: uc.id,
							targetLineType: stdCir.lineType
						},
						highlightCoords: [{
							view: kv,
							p1: {
								u: uc.center.u - uc.radius,
								v: uc.center.v
							},
							p2: {
								u: uc.center.u + uc.radius,
								v: uc.center.v
							}
						}]
					});
				}
				const kvUserSegs = userEntities.filter((e) => e.view === kv && (e.lineType === "thick_solid" || e.lineType === "thin_dashed")).flatMap((e) => expandEntityToSegments(e));
				const missingKvLines = stdViewEnts.filter((e) => e.type === "line" && (e.lineType === "thick_solid" || e.lineType === "thin_dashed") && dist2D(e.p1, e.p2) >= 2).filter((sl) => {
					const midPt = {
						u: (sl.p1.u + sl.p2.u) * .5,
						v: (sl.p1.v + sl.p2.v) * .5
					};
					return !kvUserSegs.some((us) => pointToSegmentDist(midPt, us.p1, us.p2).dist <= 1.8);
				});
				if (missingKvLines.length > 0) issues.push({
					id: `diag-known-missing-ridge-${kv}`,
					severity: "error",
					category: "hidden_conflict",
					title: lang === "en" ? `${viewName(kv)} Missing ${missingKvLines.length} Ridge/Intersection Line(s)` : lang === "zh-TW" ? `${viewName(kv)}漏畫 ${missingKvLines.length} 條交線/分界棱線` : `${viewName(kv)}漏画 ${missingKvLines.length} 条交线/分界棱线`,
					description: lang === "en" ? `3D CSG re-projection detected ${missingKvLines.length} missing internal surface intersection or fold ridge line(s) in ${viewName(kv)}.` : lang === "zh-TW" ? `將重建的 3D CSG 實體逆向重投影回${viewName(kv)}時，發現原圖漏畫了 ${missingKvLines.length} 條斜面折角分界棱線或內部虛線。` : `将重建的 3D CSG 实体逆向重投影回${viewName(kv)}时，发现原图漏画了 ${missingKvLines.length} 条斜面折角分界棱线或内部虚线。`,
					suggestion: lang === "en" ? `Complete the missing ridge/intersection lines in ${viewName(kv)} via 3D CSG re-projection.` : lang === "zh-TW" ? `一鍵補齊${viewName(kv)}缺失的分界棱線與標準消隱線。` : `一键补齐${viewName(kv)}缺失的分界棱线与标准消隐线。`,
					views: [kv],
					fixPayload: {
						type: "replace_view_entities",
						targetView: kv,
						replacementEntities: stdViewEnts
					},
					highlightCoords: missingKvLines.slice(0, 3).map((m) => ({
						view: kv,
						p1: m.p1,
						p2: m.p2
					}))
				});
			}
			const targetUserEnts = userEntities.filter((e) => e.view === targetView && e.lineType !== "construction");
			if (targetUserEnts.length > 0 && primarySol.derivedEntities.length > 0) {
				const stdDashed = primarySol.derivedEntities.filter((e) => e.lineType === "thin_dashed" && e.type === "line");
				const curDashed = targetUserEnts.filter((e) => e.lineType === "thin_dashed" && e.type === "line");
				const missingDashed = stdDashed.filter((sd) => !curDashed.some((cd) => dist2D(cd.p1, sd.p1) <= 2 && dist2D(cd.p2, sd.p2) <= 2 || dist2D(cd.p1, sd.p2) <= 2 && dist2D(cd.p2, sd.p1) <= 2));
				if (missingDashed.length > 0) issues.push({
					id: `diag-target-missing-hlr-${targetView}`,
					severity: "error",
					category: "hidden_conflict",
					title: lang === "en" ? `${viewName(targetView)} Missing ${missingDashed.length} Internal Hidden/Intersection Line(s)` : lang === "zh-TW" ? `${viewName(targetView)}缺失 ${missingDashed.length} 條內部結構虛線或截交步階線` : `${viewName(targetView)}缺失 ${missingDashed.length} 条内部结构虚线或截交步阶线`,
					description: lang === "en" ? `3D CSG re-projection detected missing internal slot/hole hidden lines or cylinder cut step lines in ${viewName(targetView)}.` : lang === "zh-TW" ? `3D CSG 逆向重投影檢測到${viewName(targetView)}缺少盲槽/通孔虛線或圓柱母線切穿處的截交線。` : `3D CSG 逆向重投影检测到${viewName(targetView)}缺少盲槽/通孔虚线或圆柱母线切穿处的截交线。`,
					suggestion: lang === "en" ? `Synchronize ${viewName(targetView)} with the exact 3D CSG projection.` : lang === "zh-TW" ? `一鍵同步為 3D CSG 嚴密消隱標準投影。` : `一键同步为 3D CSG 严密消隐标准投影。`,
					views: [targetView],
					fixPayload: {
						type: "replace_view_entities",
						targetView,
						replacementEntities: primarySol.derivedEntities
					},
					highlightCoords: missingDashed.slice(0, 3).map((m) => ({
						view: targetView,
						p1: m.p1,
						p2: m.p2
					}))
				});
			}
		}
	}
	const topCircles = userEntities.filter((e) => e.view === "top" && e.type === "circle");
	if (topCircles.length > 0) for (const tc of topCircles) {
		if (tc.type !== "circle") continue;
		if (bTop && Math.abs(tc.radius * 2 - (bTop.uMax - bTop.uMin)) < 4) continue;
		if (bFront) {
			const frontDashed = userEntities.filter((e) => e.view === "front" && e.lineType === "thin_dashed");
			const expectedX1 = tc.center.u - tc.radius;
			const expectedX2 = tc.center.u + tc.radius;
			const hasX1 = frontDashed.some((d) => d.type === "line" && (Math.abs(d.p1.u - expectedX1) < 2.5 || Math.abs(d.p2.u - expectedX1) < 2.5));
			const hasX2 = frontDashed.some((d) => d.type === "line" && (Math.abs(d.p1.u - expectedX2) < 2.5 || Math.abs(d.p2.u - expectedX2) < 2.5));
			if (!hasX1 || !hasX2) issues.push({
				id: `diag-missing-front-hidden-${tc.id}`,
				severity: "error",
				category: "hidden_conflict",
				title: lang === "en" ? `Missing Hidden Hole Lines in Front View (X=${expectedX1}, X=${expectedX2})` : lang === "zh-TW" ? `主視圖缺失內孔細虛線 (X=${expectedX1}, X=${expectedX2})` : `主视图缺失内孔细虚线 (X=${expectedX1}, X=${expectedX2})`,
				description: lang === "en" ? `Top View contains a hole at (X=${tc.center.u}, Y=${tc.center.v}), but Front View lacks matching dashed lines.` : lang === "zh-TW" ? `俯視圖存在圓孔 (X=${tc.center.u}, Y=${tc.center.v})，主視圖缺失對應細虛線。` : `俯视图存在圆孔 (X=${tc.center.u}, Y=${tc.center.v})，主视图缺失对应细虚线。`,
				suggestion: lang === "en" ? `Add dashed lines at X=${expectedX1} and X=${expectedX2} in Front View.` : lang === "zh-TW" ? `在主視圖 X=${expectedX1} 與 X=${expectedX2} 處補齊細虛線。` : `在主视图 X=${expectedX1} 与 X=${expectedX2} 处补齐细虚线。`,
				views: ["top", "front"],
				fixPayload: {
					type: "add_missing_hidden_hole",
					targetView: "front",
					holeCenterU: tc.center.u,
					holeRadius: tc.radius,
					spanMin: bFront.vMin,
					spanMax: bFront.vMax
				},
				highlightCoords: [{
					view: "front",
					p1: {
						u: expectedX1,
						v: bFront.vMin
					},
					p2: {
						u: expectedX1,
						v: bFront.vMax
					}
				}, {
					view: "front",
					p1: {
						u: expectedX2,
						v: bFront.vMin
					},
					p2: {
						u: expectedX2,
						v: bFront.vMax
					}
				}]
			});
		}
		if (bLeft) {
			const leftDashed = userEntities.filter((e) => e.view === "left" && e.lineType === "thin_dashed");
			const expectedY1 = tc.center.v - tc.radius;
			const expectedY2 = tc.center.v + tc.radius;
			const hasY1 = leftDashed.some((d) => d.type === "line" && (Math.abs(d.p1.u - expectedY1) < 2.5 || Math.abs(d.p2.u - expectedY1) < 2.5));
			const hasY2 = leftDashed.some((d) => d.type === "line" && (Math.abs(d.p1.u - expectedY2) < 2.5 || Math.abs(d.p2.u - expectedY2) < 2.5));
			if (!hasY1 || !hasY2) issues.push({
				id: `diag-missing-hidden-${tc.id}`,
				severity: "error",
				category: "hidden_conflict",
				title: lang === "en" ? `Missing Hidden Hole Lines in Left View (Y=${expectedY1}, Y=${expectedY2})` : lang === "zh-TW" ? `左視圖缺失內孔細虛線 (Y=${expectedY1}, Y=${expectedY2})` : `左视图缺失内孔细虚线 (Y=${expectedY1}, Y=${expectedY2})`,
				description: lang === "en" ? `Top View contains a hole at (X=${tc.center.u}, Y=${tc.center.v}), but Left View lacks matching dashed lines.` : lang === "zh-TW" ? `俯視圖存在圓孔 (X=${tc.center.u}, Y=${tc.center.v})，左視圖缺失對應虛線。` : `俯视图存在圆孔 (X=${tc.center.u}, Y=${tc.center.v})，左视图缺失对应虚线。`,
				suggestion: lang === "en" ? `Add dashed lines at Y=${expectedY1} and Y=${expectedY2} in Left View.` : lang === "zh-TW" ? `在左視圖 Y=${expectedY1} 與 Y=${expectedY2} 處補齊細虛線。` : `在左视图 Y=${expectedY1} 与 Y=${expectedY2} 处补齐细虚线。`,
				views: ["top", "left"],
				fixPayload: {
					type: "add_missing_hidden_hole",
					targetView: "left",
					holeCenterU: tc.center.v,
					holeRadius: tc.radius,
					spanMin: bLeft.vMin,
					spanMax: bLeft.vMax
				},
				highlightCoords: [{
					view: "left",
					p1: {
						u: expectedY1,
						v: bLeft.vMin
					},
					p2: {
						u: expectedY1,
						v: bLeft.vMax
					}
				}, {
					view: "left",
					p1: {
						u: expectedY2,
						v: bLeft.vMin
					},
					p2: {
						u: expectedY2,
						v: bLeft.vMax
					}
				}]
			});
		}
	}
	const allActiveEnts = entities.filter((e) => e.lineType !== "construction");
	const circleClustersByView: Record<string, Array<{ center: { u: number; v: number }; maxRadius: number; radii: number[] }>> = {
		front: [],
		top: [],
		left: []
	};
	for (const vw of ["front", "top", "left"] as const) {
		const viewCircs = allActiveEnts.filter((e) => e.view === vw && (e.type === "circle" || e.type === "arc" && Math.abs((e.endAngle ?? 0) - (e.startAngle ?? 0)) >= Math.PI * .5 - .15));
		const clusters: Array<{ center: { u: number; v: number }; maxRadius: number; radii: number[] }> = [];
		for (const c of viewCircs) {
			if (!c.center || !c.radius) continue;
			const existing = clusters.find((cl) => dist2D(cl.center, c.center) <= 1.5);
			if (existing) {
				existing.maxRadius = Math.max(existing.maxRadius, c.radius);
				if (!existing.radii.some((r) => Math.abs(r - c.radius) <= 1.5)) existing.radii.push(c.radius);
			} else {
				clusters.push({
					center: { u: c.center.u, v: c.center.v },
					maxRadius: c.radius,
					radii: [c.radius]
				});
			}
		}
		circleClustersByView[vw] = clusters;
		const centerLines = allActiveEnts.filter((e) => e.view === vw && e.type === "line" && e.lineType === "center_dot_dash");
		clusters.forEach((cl, cIdx) => {
			const uc = cl.center.u;
			const vc = cl.center.v;
			const R = cl.maxRadius;
			const hasHoriz = centerLines.some((ln: any) => Math.abs(ln.p1.v - vc) <= 1.5 && Math.abs(ln.p2.v - vc) <= 1.5 && Math.min(ln.p1.u, ln.p2.u) <= uc + 2 && Math.max(ln.p1.u, ln.p2.u) >= uc - 2);
			const hasVert = centerLines.some((ln: any) => Math.abs(ln.p1.u - uc) <= 1.5 && Math.abs(ln.p2.u - uc) <= 1.5 && Math.min(ln.p1.v, ln.p2.v) <= vc + 2 && Math.max(ln.p1.v, ln.p2.v) >= vc - 2);
			if (!hasHoriz || !hasVert) {
				const hCoords = [];
				if (!hasHoriz) hCoords.push({
					view: vw,
					p1: { u: uc - R - 4, v: vc },
					p2: { u: uc + R + 4, v: vc }
				});
				if (!hasVert) hCoords.push({
					view: vw,
					p1: { u: uc, v: vc - R - 4 },
					p2: { u: uc, v: vc + R + 4 }
				});
				issues.push({
					id: `diag-missing-cross-centerline-${vw}-${cIdx}`,
					severity: "warning",
					category: "missing_centerline",
					title: lang === "en" ? `${viewName(vw)} Circle (Ø${Math.round(R * 2)}) Missing Cross Centerline` : lang === "zh-TW" ? `${viewName(vw)}圓特徵 (Ø${Math.round(R * 2)}) 缺失十字對稱中心線` : `${viewName(vw)}圆特征 (Ø${Math.round(R * 2)}) 缺失十字对称中心线`,
					description: lang === "en" ? `National standard GB/T 4458.1 requires orthogonal centerlines (center_dot_dash) intersecting at circle center (${Number(uc.toFixed(1))}, ${Number(vc.toFixed(1))}) and extending 3~4mm beyond the perimeter.` : lang === "zh-TW" ? `依據機械製圖國標規範，位於 (${Number(uc.toFixed(1))}, ${Number(vc.toFixed(1))}) 的圓或同心圓孔必須繪製正交十字細點畫線（center_dot_dash），且兩端超出圓周 3~4mm。` : `依据机械制图国标规范，位于 (${Number(uc.toFixed(1))}, ${Number(vc.toFixed(1))}) 的圆或同心圆孔必须绘制正交十字细点画线（center_dot_dash），且两端超出圆周 3~4mm。`,
					suggestion: lang === "en" ? `Add standard cross centerlines at (${Number(uc.toFixed(1))}, ${Number(vc.toFixed(1))}) in ${viewName(vw)}.` : lang === "zh-TW" ? `一鍵在${viewName(vw)}補齊標準十字細點畫線。` : `一键在${viewName(vw)}补齐标准十字细点画线。`,
					views: [vw],
					fixPayload: {
						type: "add_circle_centerlines",
						targetView: vw,
						center: { u: uc, v: vc },
						radius: R,
						needHoriz: !hasHoriz,
						needVert: !hasVert
					},
					highlightCoords: hCoords
				});
			}
		});
	}
	const viewBoundsMap: Record<string, any> = { front: bFront, top: bTop, left: bLeft };
	const viewSlotsMap: Record<string, any> = {
		front: bFront ? extractOpenSlotsAndDashedBandsInView(allActiveEnts, "front", bFront) : null,
		top: bTop ? extractOpenSlotsAndDashedBandsInView(allActiveEnts, "top", bTop) : null,
		left: bLeft ? extractOpenSlotsAndDashedBandsInView(allActiveEnts, "left", bLeft) : null
	};
	const reportedAxes = /* @__PURE__ */ new Set<string>();
	for (const cView of ["front", "top", "left"] as const) {
		for (const cl of circleClustersByView[cView]) {
			for (const pView of ["front", "top", "left"] as const) {
				if (pView === cView) continue;
				const pBounds = viewBoundsMap[pView];
				const pSlots = viewSlotsMap[pView];
				if (!pBounds || !pSlots) continue;
				const orientation: "vertical" | "horizontal" = cView === "front" && pView === "top" || cView === "top" && pView === "front" || cView === "top" && pView === "left" ? "vertical" : "horizontal";
				const axisCoord = cView === "front" && pView === "top" ? cl.center.u : cView === "top" && pView === "front" ? cl.center.u : cView === "top" && pView === "left" ? cl.center.v : cView === "front" && pView === "left" ? cl.center.v : cView === "left" && pView === "front" ? cl.center.v : cl.center.u;
				if (circleClustersByView[pView].some((pcl) => Math.abs((orientation === "vertical" ? pcl.center.u : pcl.center.v) - axisCoord) <= 2)) continue;
				let matchedSpan: { min: number; max: number } | null = null;
				for (const r of cl.radii) {
					const s1 = axisCoord - r;
					const s2 = axisCoord + r;
					if (orientation === "vertical") {
						const matchBand = pSlots.uBands.find((b: any) => Math.abs(b.u1 - s1) <= 2.5 && Math.abs(b.u2 - s2) <= 2.5);
						const matchSlot = pSlots.uSlots.find((s: any) => Math.abs(s.uMin - s1) <= 2.5 && Math.abs(s.uMax - s2) <= 2.5);
						const matchOuter = Math.abs(pBounds.uMin - s1) <= 2.5 && Math.abs(pBounds.uMax - s2) <= 2.5;
						if (matchBand) matchedSpan = { min: Math.max(pBounds.vMin, matchBand.vMin), max: Math.min(pBounds.vMax, matchBand.vMax) };
						else if (matchSlot) matchedSpan = { min: Math.max(pBounds.vMin, matchSlot.vMin), max: Math.min(pBounds.vMax, matchSlot.vMax) };
						else if (matchOuter) matchedSpan = { min: pBounds.vMin, max: pBounds.vMax };
					} else {
						const matchBand = pSlots.vBands.find((b: any) => Math.abs(b.v1 - s1) <= 2.5 && Math.abs(b.v2 - s2) <= 2.5);
						const matchSlot = pSlots.uSlots.find((s: any) => Math.abs(s.vMin - s1) <= 2.5 && Math.abs(s.vMax - s2) <= 2.5);
						const matchOuter = Math.abs(pBounds.vMin - s1) <= 2.5 && Math.abs(pBounds.vMax - s2) <= 2.5;
						if (matchBand) matchedSpan = { min: Math.max(pBounds.uMin, matchBand.uMin), max: Math.min(pBounds.uMax, matchBand.uMax) };
						else if (matchSlot) matchedSpan = { min: Math.max(pBounds.uMin, matchSlot.uMin), max: Math.min(pBounds.uMax, matchSlot.uMax) };
						else if (matchOuter) matchedSpan = { min: pBounds.uMin, max: pBounds.uMax };
					}
					if (matchedSpan) break;
				}
				if (!matchedSpan) continue;
				const axisKey = `${pView}-${orientation}-${Math.round(axisCoord)}`;
				if (reportedAxes.has(axisKey)) continue;
				const pCenterLines = allActiveEnts.filter((e) => e.view === pView && e.type === "line" && e.lineType === "center_dot_dash");
				const hasAxis = orientation === "vertical" ? pCenterLines.some((ln: any) => Math.abs(ln.p1.u - axisCoord) <= 1.5 && Math.abs(ln.p2.u - axisCoord) <= 1.5 && Math.max(ln.p1.v, ln.p2.v) - Math.min(ln.p1.v, ln.p2.v) >= 4) : pCenterLines.some((ln: any) => Math.abs(ln.p1.v - axisCoord) <= 1.5 && Math.abs(ln.p2.v - axisCoord) <= 1.5 && Math.max(ln.p1.u, ln.p2.u) - Math.min(ln.p1.u, ln.p2.u) >= 4);
				if (!hasAxis) {
					reportedAxes.add(axisKey);
					const p1 = orientation === "vertical" ? { u: axisCoord, v: matchedSpan.min - 4 } : { u: matchedSpan.min - 4, v: axisCoord };
					const p2 = orientation === "vertical" ? { u: axisCoord, v: matchedSpan.max + 4 } : { u: matchedSpan.max + 4, v: axisCoord };
					issues.push({
						id: `diag-missing-rev-axis-${axisKey}`,
						severity: "warning",
						category: "missing_centerline",
						title: lang === "en" ? `${viewName(pView)} Missing Axis of Revolution / Hole Centerline` : lang === "zh-TW" ? `${viewName(pView)}缺失回轉體/圓孔軸線（細點畫線）` : `${viewName(pView)}缺失回转体/圆孔轴线（细点画线）`,
						description: lang === "en" ? `Cylindrical, frustum, or hole feature paired with ${viewName(cView)} requires a centerline axis (center_dot_dash) in ${viewName(pView)} along ${orientation === "vertical" ? `U = ${Number(axisCoord.toFixed(1))}` : `V = ${Number(axisCoord.toFixed(1))}`}.` : lang === "zh-TW" ? `與${viewName(cView)}配對的圓柱、圓台或圓孔特徵，必須在${viewName(pView)}對應位置（${orientation === "vertical" ? `U = ${Number(axisCoord.toFixed(1))}` : `V = ${Number(axisCoord.toFixed(1))}`}）繪製細點畫線（center_dot_dash）回轉軸線。` : `与${viewName(cView)}配对的圆柱、圆台或圆孔特征，必须在${viewName(pView)}对应位置（${orientation === "vertical" ? `U = ${Number(axisCoord.toFixed(1))}` : `V = ${Number(axisCoord.toFixed(1))}`}）绘制细点画线（center_dot_dash）回转轴线。`,
						suggestion: lang === "en" ? `Add a standard centerline axis in ${viewName(pView)}.` : lang === "zh-TW" ? `一鍵在${viewName(pView)}補齊標準回轉軸線。` : `一键在${viewName(pView)}补齐标准回转轴线。`,
						views: [cView, pView],
						fixPayload: {
							type: "add_revolution_axis",
							targetView: pView,
							orientation,
							axisCoord,
							spanMin: matchedSpan.min,
							spanMax: matchedSpan.max
						},
						highlightCoords: [{
							view: pView,
							p1,
							p2
						}]
					});
				}
			}
		}
	}
	if (reconstructedSols.length > 1) issues.push({
		id: "diag-under-constrained-multi",
		severity: "warning",
		category: "under_constrained",
		title: lang === "en" ? `Under-Constrained Internal Feature (${reconstructedSols.length} Candidate 3D Solutions)` : lang === "zh-TW" ? `內部閉合特徵欠約束（已生成 ${reconstructedSols.length} 個候選 3D 解）` : `内部闭合特征欠约束（已生成 ${reconstructedSols.length} 个候选 3D 解）`,
		description: lang === "en" ? "An internal closed contour has no explicit depth dashed lines in the adjacent view. It can be interpreted as a through-cut, blind slot, or protruding boss." : lang === "zh-TW" ? "檢測到某視圖內的閉合框未在相鄰視圖給出明確深度虛線，存在「全貫通槽 / 半深盲槽 / 外凸台」多解。" : "检测到某视图内的闭合框未在相邻视图给出明确深度虚线，存在“全贯通槽 / 半深盲槽 / 外凸台”多解。",
		suggestion: lang === "en" ? "Use the Candidate Solution Switcher in the 3D viewport to compare each valid 3D solid." : lang === "zh-TW" ? "可在 3D 視窗右上角直接切換對比各個候選三維構型。" : "可在 3D 视窗右上角直接切换对比各个候选三维构型。",
		views: knownViews
	});
	return issues;
}
/**
* Fix a Single Diagnostic Issue Independently while Preserving Topological Closure
*/
export function fixSingleDiagnosticIssue(issue, entities) {
	const payload = issue.fixPayload;
	if (!payload) return entities;
	if (payload.type === "align_axis" && payload.coordKey && payload.actualVal !== void 0 && payload.expectedVal !== void 0) {
		const { targetView, coordKey, actualVal, expectedVal } = payload;
		const tol = 2;
		return entities.map((ent) => {
			if (ent.view !== targetView) return ent;
			if (ent.type === "rect") {
				if (coordKey === "u") {
					const xMin = ent.x;
					const xMax = ent.x + ent.width;
					if (Math.abs(xMax - actualVal) <= tol) {
						const newW = Math.max(4, expectedVal - xMin);
						return {
							...ent,
							width: Number(newW.toFixed(1))
						};
					}
					if (Math.abs(xMin - actualVal) <= tol) {
						const newW = Math.max(4, xMax - expectedVal);
						return {
							...ent,
							x: Number(expectedVal.toFixed(1)),
							width: Number(newW.toFixed(1))
						};
					}
				} else {
					const yMin = ent.y;
					const yMax = ent.y + ent.height;
					if (Math.abs(yMax - actualVal) <= tol) {
						const newH = Math.max(4, expectedVal - yMin);
						return {
							...ent,
							height: Number(newH.toFixed(1))
						};
					}
					if (Math.abs(yMin - actualVal) <= tol) {
						const newH = Math.max(4, yMax - expectedVal);
						return {
							...ent,
							y: Number(expectedVal.toFixed(1)),
							height: Number(newH.toFixed(1))
						};
					}
				}
			}
			if (ent.type === "line") {
				const p1Val = ent.p1[coordKey];
				const p2Val = ent.p2[coordKey];
				const nextP1 = Math.abs(p1Val - actualVal) <= tol ? {
					...ent.p1,
					[coordKey]: expectedVal
				} : ent.p1;
				const nextP2 = Math.abs(p2Val - actualVal) <= tol ? {
					...ent.p2,
					[coordKey]: expectedVal
				} : ent.p2;
				return {
					...ent,
					p1: nextP1,
					p2: nextP2
				};
			}
			if (ent.type === "polygon") return {
				...ent,
				points: ent.points.map((pt) => Math.abs(pt[coordKey] - actualVal) <= tol ? {
					...pt,
					[coordKey]: expectedVal
				} : pt)
			};
			return ent;
		});
	}
	if (payload.type === "add_missing_hidden_hole" && payload.holeCenterU !== void 0 && payload.holeRadius !== void 0 && payload.spanMin !== void 0 && payload.spanMax !== void 0) {
		const { targetView, holeCenterU, holeRadius, spanMin, spanMax } = payload;
		const u1 = Number((holeCenterU - holeRadius).toFixed(1));
		const u2 = Number((holeCenterU + holeRadius).toFixed(1));
		const stamp = Date.now();
		const newLines = [
			{
				id: `fix-hlr-1-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "thin_dashed",
				p1: {
					u: u1,
					v: spanMin
				},
				p2: {
					u: u1,
					v: spanMax
				},
				source: "user"
			},
			{
				id: `fix-hlr-2-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "thin_dashed",
				p1: {
					u: u2,
					v: spanMin
				},
				p2: {
					u: u2,
					v: spanMax
				},
				source: "user"
			},
			{
				id: `fix-axis-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "center_dot_dash",
				p1: {
					u: holeCenterU,
					v: spanMin - 4
				},
				p2: {
					u: holeCenterU,
					v: spanMax + 4
				},
				source: "user"
			}
		];
		return [...entities, ...newLines];
	}
	if (payload.type === "add_circle_centerlines" && payload.center && payload.radius !== void 0) {
		const { targetView, center, radius, needHoriz, needVert } = payload;
		const stamp = Date.now();
		const ext = Number((radius + 4).toFixed(1));
		const added = [];
		if (needHoriz) {
			added.push({
				id: `fix-cl-h-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "center_dot_dash",
				p1: { u: Number((center.u - ext).toFixed(1)), v: Number(center.v.toFixed(1)) },
				p2: { u: Number((center.u + ext).toFixed(1)), v: Number(center.v.toFixed(1)) },
				source: "user"
			});
		}
		if (needVert) {
			added.push({
				id: `fix-cl-v-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "center_dot_dash",
				p1: { u: Number(center.u.toFixed(1)), v: Number((center.v - ext).toFixed(1)) },
				p2: { u: Number(center.u.toFixed(1)), v: Number((center.v + ext).toFixed(1)) },
				source: "user"
			});
		}
		return [...entities, ...added];
	}
	if (payload.type === "add_revolution_axis" && payload.axisCoord !== void 0 && payload.spanMin !== void 0 && payload.spanMax !== void 0) {
		const { targetView, orientation, axisCoord, spanMin, spanMax } = payload;
		const stamp = Date.now();
		const p1 = orientation === "vertical" ? { u: Number(axisCoord.toFixed(1)), v: Number((spanMin - 4).toFixed(1)) } : { u: Number((spanMin - 4).toFixed(1)), v: Number(axisCoord.toFixed(1)) };
		const p2 = orientation === "vertical" ? { u: Number(axisCoord.toFixed(1)), v: Number((spanMax + 4).toFixed(1)) } : { u: Number((spanMax + 4).toFixed(1)), v: Number(axisCoord.toFixed(1)) };
		return [
			...entities,
			{
				id: `fix-rev-axis-${targetView}-${stamp}`,
				view: targetView,
				type: "line",
				lineType: "center_dot_dash",
				p1,
				p2,
				source: "user"
			}
		];
	}
	if (payload.type === "close_dangling" && payload.danglingEntityId && payload.danglingEndpoint && payload.snapTargetPt) {
		const { danglingEntityId, danglingEndpoint, snapTargetPt } = payload;
		return entities.map((ent) => {
			if (ent.id !== danglingEntityId || ent.type !== "line") return ent;
			return {
				...ent,
				[danglingEndpoint]: {
					u: Number(snapTargetPt.u.toFixed(1)),
					v: Number(snapTargetPt.v.toFixed(1))
				}
			};
		});
	}
	if (payload.type === "convert_linetype" && payload.entityId && payload.targetLineType) return entities.map((ent) => ent.id === payload.entityId ? {
		...ent,
		lineType: payload.targetLineType
	} : ent);
	if (payload.type === "replace_view_entities" && payload.replacementEntities) return [...entities.filter((e) => e.view !== payload.targetView), ...payload.replacementEntities];
	return entities;
}


export const deriveThirdView = deriveFromCustomViews;
export const applyDiagnosticFix = fixSingleDiagnosticIssue;
