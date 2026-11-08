import * as import_react from "react";
import * as import_jsx_runtime from "react/jsx-runtime";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Clock,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MOUSE,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { Maximize2, Minimize2 } from "lucide-react";

// src/components/Viewport3D.tsx
function ensureOutwardNormals(geom: BufferGeometry): BufferGeometry {
	const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
	const posAttr: any = nonIndexed.getAttribute("position");
	if (!posAttr || posAttr.count < 3) return nonIndexed;
	let vol6 = 0;
	const v0 = new Vector3();
	const v1 = new Vector3();
	const v2 = new Vector3();
	const cross = new Vector3();
	for (let i = 0; i + 2 < posAttr.count; i += 3) {
		v0.fromBufferAttribute(posAttr, i);
		v1.fromBufferAttribute(posAttr, i + 1);
		v2.fromBufferAttribute(posAttr, i + 2);
		cross.copy(v0).cross(v1);
		vol6 += cross.dot(v2);
	}
	if (vol6 < 0) {
		for (let i = 0; i + 2 < posAttr.count; i += 3) {
			const x1 = posAttr.getX(i + 1), y1 = posAttr.getY(i + 1), z1 = posAttr.getZ(i + 1);
			const x2 = posAttr.getX(i + 2), y2 = posAttr.getY(i + 2), z2 = posAttr.getZ(i + 2);
			posAttr.setXYZ(i + 1, x2, y2, z2);
			posAttr.setXYZ(i + 2, x1, y1, z1);
		}
		posAttr.needsUpdate = true;
	}
	nonIndexed.computeVertexNormals();
	return nonIndexed;
}

function buildOrdered2DRing(rawPts: any[], segs?: any[]): { u: number; v: number }[] {
	const dist2 = (a: { u: number; v: number }, b: { u: number; v: number }) => Math.hypot(a.u - b.u, a.v - b.v);
	const ring: { u: number; v: number }[] = [];
	if (Array.isArray(segs) && segs.length > 0) {
		const N_ARC = 40;
		let currPt: { u: number; v: number } | null = null;
		for (let sIdx = 0; sIdx < segs.length; sIdx++) {
			const s = segs[sIdx];
			if (s.kind === "arc" && s.center && Number.isFinite(s.radius) && s.startAngle !== void 0 && s.endAngle !== void 0) {
				let span = (s.endAngle - s.startAngle) % (Math.PI * 2);
				if (span < 0) span += Math.PI * 2;
				if (span < 1e-4) span = Math.PI * 2;
				const sampled: { u: number; v: number }[] = [];
				for (let k = 0; k <= N_ARC; k++) {
					const ang = s.startAngle + (k / N_ARC) * span;
					sampled.push({
						u: s.center.u + s.radius * Math.cos(ang),
						v: s.center.v + s.radius * Math.sin(ang)
					});
				}
				const arcStart = sampled[0];
				const arcEnd = sampled[sampled.length - 1];
				const refPt = currPt || s.p1 || arcStart;
				if (dist2(arcEnd, refPt) + 1e-3 < dist2(arcStart, refPt)) {
					sampled.reverse();
				}
				for (const pt of sampled) {
					if (ring.length === 0 || dist2(ring[ring.length - 1], pt) > 0.05) {
						ring.push(pt);
					}
				}
				currPt = ring[ring.length - 1] || null;
			} else if (s.p1 && s.p2) {
				let pStart = s.p1;
				let pEnd = s.p2;
				if (currPt && dist2(pEnd, currPt) + 1e-3 < dist2(pStart, currPt)) {
					pStart = s.p2;
					pEnd = s.p1;
				}
				if (ring.length === 0 || dist2(ring[ring.length - 1], pStart) > 0.05) {
					ring.push({ u: pStart.u, v: pStart.v });
				}
				if (dist2(ring[ring.length - 1], pEnd) > 0.05) {
					ring.push({ u: pEnd.u, v: pEnd.v });
				}
				currPt = ring[ring.length - 1] || null;
			}
		}
	} else if (Array.isArray(rawPts)) {
		for (const pt of rawPts) {
			if (pt && Number.isFinite(pt.u) && Number.isFinite(pt.v)) {
				if (ring.length === 0 || dist2(ring[ring.length - 1], pt) > 0.05) {
					ring.push({ u: pt.u, v: pt.v });
				}
			}
		}
	}
	if (ring.length >= 2 && dist2(ring[0], ring[ring.length - 1]) <= 0.1) {
		ring.pop();
	}
	return ring;
}

function createPrimitiveGeometry(prim) {
	const pad = prim.operation === "subtract" ? .6 : 0;
	const dx = Math.max(1, prim.xMax - prim.xMin) + pad * 2;
	const dy = Math.max(1, prim.yMax - prim.yMin) + pad * 2;
	const dz = Math.max(1, prim.zMax - prim.zMin) + pad * 2;
	const cx = (prim.xMin + prim.xMax) / 2 - 60;
	const cy = (prim.zMin + prim.zMax) / 2 - 50;
	const cz = (prim.yMin + prim.yMax) / 2 - 60;
	const polyPts = prim.prismPolygon || prim.polygon2D;
	if (prim.shape === "prism" && Array.isArray(polyPts) && polyPts.length >= 3) {
		const segs = prim.prismSegments;
		const ring2D = buildOrdered2DRing(polyPts, segs);
		if (ring2D.length >= 3) {
			const axis = (prim.prismAxis || prim.extrudeAxis || "Y").toString().toUpperCase();
			const buildCCWShape = (mapU: (u: number) => number, mapV: (v: number) => number) => {
				const mapped = ring2D.map((p) => ({ x: mapU(p.u), y: mapV(p.v) }));
				let signedArea = 0;
				for (let i = 0; i < mapped.length; i++) {
					const a = mapped[i];
					const b = mapped[(i + 1) % mapped.length];
					signedArea += a.x * b.y - b.x * a.y;
				}
				if (signedArea < 0) mapped.reverse();
				const sh = new Shape();
				mapped.forEach((pt, idx) => {
					if (idx === 0) sh.moveTo(pt.x, pt.y);
					else sh.lineTo(pt.x, pt.y);
				});
				sh.closePath();
				return sh;
			};
			if (axis === "Y") {
				const shape = buildCCWShape((u) => u - 60, (v) => v - 50);
				const geom = new ExtrudeGeometry(shape, {
					depth: dy,
					bevelEnabled: false,
					curveSegments: 36
				});
				geom.translate(0, 0, prim.yMin - pad - 60);
				return ensureOutwardNormals(geom);
			}
			if (axis === "Z") {
				const shape = buildCCWShape((u) => u - 60, (v) => -(v - 60));
				const geom = new ExtrudeGeometry(shape, {
					depth: dz,
					bevelEnabled: false,
					curveSegments: 36
				});
				geom.rotateX(-Math.PI / 2);
				geom.translate(0, prim.zMin - pad - 50, 0);
				return ensureOutwardNormals(geom);
			}
			const shape = buildCCWShape((u) => -(u - 60), (v) => v - 50);
			const geom = new ExtrudeGeometry(shape, {
				depth: dx,
				bevelEnabled: false,
				curveSegments: 36
			});
			geom.rotateY(Math.PI / 2);
			geom.translate(prim.xMin - pad - 60, 0, 0);
			return ensureOutwardNormals(geom);
		}
	}
	if (prim.shape === "cylinder_z") {
		const r = prim.radius || Math.min(dx, dy) / 2;
		const geom = new CylinderGeometry(r, r, prim.operation === "subtract" ? dz + 1.2 : dz, 36);
		const px = (prim.centerX ?? (prim.xMin + prim.xMax) / 2) - 60;
		const pz = (prim.centerY ?? (prim.yMin + prim.yMax) / 2) - 60;
		geom.translate(px, cy, pz);
		return geom;
	}
	if (prim.shape === "cylinder_x") {
		const r = prim.radius || Math.min(dy, dz) / 2;
		const geom = new CylinderGeometry(r, r, prim.operation === "subtract" ? dx + 1.2 : dx, 36);
		geom.rotateZ(Math.PI / 2);
		const py = (prim.centerZ ?? (prim.zMin + prim.zMax) / 2) - 50;
		const pz = (prim.centerY ?? (prim.yMin + prim.yMax) / 2) - 60;
		geom.translate(cx, py, pz);
		return geom;
	}
	if (prim.shape === "cylinder_y") {
		const r = prim.radius || Math.min(dx, dz) / 2;
		const geom = new CylinderGeometry(r, r, prim.operation === "subtract" ? dy + 1.2 : dy, 36);
		geom.rotateX(Math.PI / 2);
		const px = (prim.centerX ?? (prim.xMin + prim.xMax) / 2) - 60;
		const py = (prim.centerZ ?? (prim.zMin + prim.zMax) / 2) - 50;
		geom.translate(px, py, cz);
		return geom;
	}
	if (prim.shape === "sphere") {
		const geom = new SphereGeometry(prim.radius || Math.min(dx, dy, dz) / 2, 48, 36);
		const px = (prim.centerX ?? (prim.xMin + prim.xMax) / 2) - 60;
		const py = (prim.centerZ ?? (prim.zMin + prim.zMax) / 2) - 50;
		const pz = (prim.centerY ?? (prim.yMin + prim.yMax) / 2) - 60;
		geom.translate(px, py, pz);
		return geom;
	}
	if (prim.shape === "hemisphere") {
		const r = prim.radius || Math.max(dx, dy, dz) / 2;
		const cX = prim.centerX ?? (prim.xMin + prim.xMax) / 2;
		const cY = prim.centerY ?? (prim.yMin + prim.yMax) / 2;
		const cZ = prim.centerZ ?? prim.zMin;
		const sx = cX - 60;
		const sy = cZ - 50;
		const sz = cY - 60;
		const xLo = Math.abs(cX - prim.xMin) <= 3.5 && prim.xMax > cX + 3.5 ? cX - 0.04 : prim.xMin - 4;
		const xHi = Math.abs(cX - prim.xMax) <= 3.5 && prim.xMin < cX - 3.5 ? cX + 0.04 : prim.xMax + 4;
		const yLo = Math.abs(cY - prim.yMin) <= 3.5 && prim.yMax > cY + 3.5 ? cY - 0.04 : prim.yMin - 4;
		const yHi = Math.abs(cY - prim.yMax) <= 3.5 && prim.yMin < cY - 3.5 ? cY + 0.04 : prim.yMax + 4;
		const zLo = Math.abs(cZ - prim.zMin) <= 3.5 && prim.zMax > cZ + 3.5 ? cZ - 0.04 : prim.zMin - 4;
		const zHi = Math.abs(cZ - prim.zMax) <= 3.5 && prim.zMin < cZ - 3.5 ? cZ + 0.04 : prim.zMax + 4;
		const sphBrush = new Brush(new SphereGeometry(r, 48, 36));
		sphBrush.position.set(sx, sy, sz);
		sphBrush.updateMatrixWorld();
		const boxBrush = new Brush(new BoxGeometry(Math.max(1, xHi - xLo), Math.max(1, zHi - zLo), Math.max(1, yHi - yLo)));
		boxBrush.position.set(0.5 * (xLo + xHi) - 60, 0.5 * (zLo + zHi) - 50, 0.5 * (yLo + yHi) - 60);
		boxBrush.updateMatrixWorld();
		const evalGeom = new Evaluator().evaluate(sphBrush, boxBrush, INTERSECTION).geometry;
		return ensureOutwardNormals(evalGeom);
	}
	if (prim.shape === "cone_z" || prim.shape === "cone_y" || prim.shape === "cone_x") {
		const isZ = prim.shape === "cone_z";
		const isY = prim.shape === "cone_y";
		const rBottom = Math.max(.05, prim.rMin ?? prim.radius ?? (isZ ? Math.min(dx, dy) : isY ? Math.min(dx, dz) : Math.min(dy, dz)) / 2);
		const rTop = Math.max(.05, prim.rMax ?? 0);
		const defU = isZ ? (prim.centerX ?? (prim.xMin + prim.xMax) / 2) : isY ? (prim.centerX ?? (prim.xMin + prim.xMax) / 2) : (prim.centerY ?? (prim.yMin + prim.yMax) / 2);
		const defV = isZ ? (prim.centerY ?? (prim.yMin + prim.yMax) / 2) : isY ? (prim.centerZ ?? (prim.zMin + prim.zMax) / 2) : (prim.centerZ ?? (prim.zMin + prim.zMax) / 2);
		const uC0 = prim.uCenterMin ?? defU;
		const uC1 = prim.uCenterMax ?? defU;
		const vC0 = prim.vCenterMin ?? defV;
		const vC1 = prim.vCenterMax ?? defV;
		const isEccentric = Math.abs(uC0 - uC1) > 0.05 || Math.abs(vC0 - vC1) > 0.05;
		if (isEccentric) {
			const N = 48;
			const w0 = isZ ? prim.zMin : isY ? prim.yMin : prim.xMin;
			const w1 = isZ ? prim.zMax : isY ? prim.yMax : prim.xMax;
			const toThree = (u: number, v: number, w: number): [number, number, number] => {
				if (isZ) return [u - 60, w - 50, v - 60];
				if (isY) return [u - 60, v - 50, w - 60];
				return [w - 60, v - 50, u - 60];
			};
			const ring0: [number, number, number][] = [];
			const ring1: [number, number, number][] = [];
			for (let i = 0; i < N; i++) {
				const th = (i / N) * Math.PI * 2;
				const c = Math.cos(th);
				const s = Math.sin(th);
				ring0.push(toThree(uC0 + rBottom * c, vC0 + rBottom * s, w0));
				ring1.push(toThree(uC1 + rTop * c, vC1 + rTop * s, w1));
			}
			const c0 = toThree(uC0, vC0, w0);
			const c1 = toThree(uC1, vC1, w1);
			const positions: number[] = [];
			const pushTri = (a: [number, number, number], b: [number, number, number], d: [number, number, number]) => {
				positions.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
			};
			for (let i = 0; i < N; i++) {
				const ni = (i + 1) % N;
				pushTri(ring0[i], ring0[ni], ring1[ni]);
				pushTri(ring0[i], ring1[ni], ring1[i]);
				pushTri(c0, ring0[ni], ring0[i]);
				pushTri(c1, ring1[i], ring1[ni]);
			}
			const fGeom = new BufferGeometry();
			fGeom.setAttribute("position", new Float32BufferAttribute(positions, 3));
			return ensureOutwardNormals(fGeom);
		}
		if (isZ) {
			const geom = new CylinderGeometry(rTop, rBottom, dz, 48);
			geom.translate(defU - 60, cy, defV - 60);
			return geom;
		}
		if (isY) {
			const geom = new CylinderGeometry(rTop, rBottom, dy, 48);
			geom.rotateX(Math.PI / 2);
			geom.translate(defU - 60, defV - 50, cz);
			return geom;
		}
		const geom = new CylinderGeometry(rTop, rBottom, dx, 48);
		geom.rotateZ(-Math.PI / 2);
		geom.translate(cx, defV - 50, defU - 60);
		return geom;
	}
	if (prim.shape === "pyramid" && Array.isArray(polyPts) && polyPts.length >= 3 && prim.apex3D) {
		const ring2D = buildOrdered2DRing(polyPts, prim.prismSegments);
		const pts = ring2D.length >= 3 ? ring2D : polyPts;
		let signedArea2D = 0;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			signedArea2D += a.u * b.v - b.u * a.v;
		}
		if (signedArea2D < 0) pts.reverse();
		const axis = (prim.prismAxis || prim.extrudeAxis || "Z").toString().toUpperCase();
		const [ax, ay, az] = prim.apex3D;
		const apexV = new Vector3(ax - 60, az - 50, ay - 60);
		const baseW = axis === "Z" ? Math.abs(az - prim.zMin) > Math.abs(az - prim.zMax) ? prim.zMin : prim.zMax : axis === "Y" ? Math.abs(ay - prim.yMin) > Math.abs(ay - prim.yMax) ? prim.yMin : prim.yMax : Math.abs(ax - prim.xMin) > Math.abs(ax - prim.xMax) ? prim.xMin : prim.xMax;
		const baseVerts = pts.map((p) => {
			if (axis === "Z") return new Vector3(p.u - 60, baseW - 50, p.v - 60);
			if (axis === "Y") return new Vector3(p.u - 60, p.v - 50, baseW - 60);
			return new Vector3(baseW - 60, p.v - 50, p.u - 60);
		});
		const positions: number[] = [];
		const centroid = baseVerts.reduce((acc, v) => acc.add(v), new Vector3()).divideScalar(baseVerts.length);
		const pushTriOutward = (a: Vector3, b: Vector3, c: Vector3, refInside: Vector3) => {
			const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
			const toOut = new Vector3().subVectors(a, refInside);
			if (n.dot(toOut) < 0) positions.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
			else positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
		};
		const topScale = typeof prim.pyramidTopScale === "number" && prim.pyramidTopScale > 1e-3 ? prim.pyramidTopScale : 0;
		if (topScale > 1e-3) {
			const topVerts = baseVerts.map((bv) => bv.clone().lerp(apexV, 1 - topScale));
			const topCentroid = topVerts.reduce((acc, v) => acc.add(v), new Vector3()).divideScalar(topVerts.length);
			const interiorRef = centroid.clone().lerp(topCentroid, 0.5);
			for (let i = 0; i < baseVerts.length; i++) {
				const b1 = baseVerts[i];
				const b2 = baseVerts[(i + 1) % baseVerts.length];
				const t1 = topVerts[i];
				const t2 = topVerts[(i + 1) % topVerts.length];
				pushTriOutward(centroid, b1, b2, interiorRef);
				pushTriOutward(topCentroid, t2, t1, interiorRef);
				pushTriOutward(b1, b2, t2, interiorRef);
				pushTriOutward(b1, t2, t1, interiorRef);
			}
		} else {
			const interiorRef = centroid.clone().lerp(apexV, .25);
			for (let i = 0; i < baseVerts.length; i++) {
				const v1 = baseVerts[i];
				const v2 = baseVerts[(i + 1) % baseVerts.length];
				pushTriOutward(v1, v2, apexV, interiorRef);
				pushTriOutward(centroid, v1, v2, interiorRef);
			}
		}
		const geom = new BufferGeometry();
		geom.setAttribute("position", new Float32BufferAttribute(positions, 3));
		return ensureOutwardNormals(geom);
	}
	if (prim.shape === "plane_sheet" && prim.vertices3D && prim.vertices3D.length >= 3) {
		const verts = prim.vertices3D.map(([vx, vy, vz]) => new Vector3(vx - 60, vz - 50, vy - 60));
		const n = new Vector3().subVectors(verts[1], verts[0]).cross(new Vector3().subVectors(verts[2], verts[0])).normalize();
		const halfT = .25;
		const topV = verts.map((v) => v.clone().addScaledVector(n, halfT));
		const botV = verts.map((v) => v.clone().addScaledVector(n, -.25));
		const positions = [];
		for (let i = 1; i < verts.length - 1; i++) positions.push(topV[0].x, topV[0].y, topV[0].z, topV[i].x, topV[i].y, topV[i].z, topV[i + 1].x, topV[i + 1].y, topV[i + 1].z, botV[0].x, botV[0].y, botV[0].z, botV[i + 1].x, botV[i + 1].y, botV[i + 1].z, botV[i].x, botV[i].y, botV[i].z);
		for (let i = 0; i < verts.length; i++) {
			const j = (i + 1) % verts.length;
			positions.push(botV[i].x, botV[i].y, botV[i].z, botV[j].x, botV[j].y, botV[j].z, topV[j].x, topV[j].y, topV[j].z, botV[i].x, botV[i].y, botV[i].z, topV[j].x, topV[j].y, topV[j].z, topV[i].x, topV[i].y, topV[i].z);
		}
		const geom = new BufferGeometry();
		geom.setAttribute("position", new Float32BufferAttribute(positions, 3));
		geom.computeVertexNormals();
		return geom;
	}
	if (prim.shape === "wedge_y") {
		const shape = new Shape();
		shape.moveTo(-dy / 2, -dz / 2);
		shape.lineTo(dy / 2, -dz / 2);
		shape.lineTo(dy / 2, dz / 2);
		shape.closePath();
		const extrude = new ExtrudeGeometry(shape, {
			depth: dx,
			bevelEnabled: false
		});
		extrude.translate(0, 0, -dx / 2);
		extrude.rotateY(-Math.PI / 2);
		extrude.translate(cx, cy, cz);
		return extrude;
	}
	const box = new BoxGeometry(dx, dz, dy);
	box.translate(cx, cy, cz);
	return box;
}
function extractCleanFeatureEdges(geometry, thresholdDeg = 35) {
	const posAttr = geometry.getAttribute("position");
	if (!posAttr) return new BufferGeometry();
	const indexAttr = geometry.getIndex();
	const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
	const cosThreshold = Math.cos(thresholdDeg * Math.PI / 180);
	const posKey = (x, y, z) => `${Math.round(x * 100)}_${Math.round(y * 100)}_${Math.round(z * 100)}`;
	const edgeMap = /* @__PURE__ */ new Map();
	const vA = new Vector3();
	const vB = new Vector3();
	const vC = new Vector3();
	const cb = new Vector3();
	const ab = new Vector3();
	const addDirectedEdge = (p1, k1, p2, k2, normal) => {
		if (k1 === k2) return;
		const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
		let rec = edgeMap.get(edgeKey);
		if (!rec) {
			rec = {
				ax: p1.x,
				ay: p1.y,
				az: p1.z,
				bx: p2.x,
				by: p2.y,
				bz: p2.z,
				normals: [normal.clone()]
			};
			edgeMap.set(edgeKey, rec);
		} else rec.normals.push(normal.clone());
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
		cb.cross(ab);
		if (cb.lengthSq() < 1e-10) continue;
		cb.normalize();
		const kA = posKey(vA.x, vA.y, vA.z);
		const kB = posKey(vB.x, vB.y, vC.z === vB.z ? vB.z : vB.z);
		const kC = posKey(vC.x, vC.y, vC.z);
		addDirectedEdge(vA, kA, vB, kB, cb);
		addDirectedEdge(vB, kB, vC, kC, cb);
		addDirectedEdge(vC, kC, vA, kA, cb);
	}
	const vertices = [];
	for (const rec of edgeMap.values()) {
		if (rec.normals.length < 2) continue;
		let isSharp = false;
		for (let i = 0; i < rec.normals.length; i++) {
			for (let j = i + 1; j < rec.normals.length; j++) if (rec.normals[i].dot(rec.normals[j]) < cosThreshold) {
				isSharp = true;
				break;
			}
			if (isSharp) break;
		}
		if (isSharp) vertices.push(rec.ax, rec.ay, rec.az, rec.bx, rec.by, rec.bz);
	}
	const outGeom = new BufferGeometry();
	outGeom.setAttribute("position", new Float32BufferAttribute(vertices, 3));
	return outGeom;
}
const MATERIAL_PRESETS: Record<string, { color: number; metalness: number; roughness: number; clearcoat: number; edgeColor: number }> = {
	steel: { color: 6583435, metalness: .55, roughness: .28, clearcoat: .25, edgeColor: 14870768 },
	aluminum: { color: 12108488, metalness: .72, roughness: .22, clearcoat: .3, edgeColor: 16317692 },
	brass: { color: 13805638, metalness: .78, roughness: .24, clearcoat: .2, edgeColor: 16708538 },
	ceramic: { color: 13490148, metalness: .08, roughness: .16, clearcoat: .65, edgeColor: 9743554 }
};
export const Viewport3D: any = ({ primitives, hoveredFeatureId, xRayMode, onToggleXRay, isFullscreen, onToggleFullscreen, materialPreset = "steel", labels }) => {
	const mountRef = (0, import_react.useRef)(null);
	const [activePreset, setActivePreset] = (0, import_react.useState)("iso");
	const stateRef = (0, import_react.useRef)({
		primitives,
		hoveredFeatureId,
		xRayMode,
		materialPreset,
		cameraTransitioning: false,
		desiredCamPos: new Vector3(95, 78, 105),
		desiredTarget: new Vector3(0, 0, 0)
	});
	const requestRenderRef = (0, import_react.useRef)(() => {});
	const rebuildModelRef = (0, import_react.useRef)(() => {});
	(0, import_react.useEffect)(() => {
		stateRef.current.hoveredFeatureId = hoveredFeatureId;
		stateRef.current.xRayMode = xRayMode;
		stateRef.current.materialPreset = materialPreset;
		requestRenderRef.current();
	}, [hoveredFeatureId, xRayMode, materialPreset]);
	(0, import_react.useEffect)(() => {
		stateRef.current.primitives = primitives;
		let rafId = 0;
		const timerId = window.setTimeout(() => {
			rafId = requestAnimationFrame(() => {
				rebuildModelRef.current();
				requestRenderRef.current();
			});
		}, 16);
		return () => {
			window.clearTimeout(timerId);
			if (rafId) cancelAnimationFrame(rafId);
		};
	}, [primitives]);
	const triggerCameraView = (preset) => {
		setActivePreset(preset);
		stateRef.current.cameraTransitioning = true;
		if (preset === "iso") stateRef.current.desiredCamPos.set(95, 78, 105);
		else if (preset === "front") stateRef.current.desiredCamPos.set(0, 5, 145);
		else if (preset === "top") stateRef.current.desiredCamPos.set(0, 150, .01);
		else if (preset === "left") stateRef.current.desiredCamPos.set(-145, 5, 0);
		stateRef.current.desiredTarget.set(0, 0, 0);
		requestRenderRef.current();
	};
	(0, import_react.useEffect)(() => {
		const container = mountRef.current;
		if (!container) return;
		const isSoftwareGl = (() => {
			const gl = document.createElement("canvas").getContext("webgl2");
			if (!gl) return true;
			const ext = gl.getExtension("WEBGL_debug_renderer_info");
			const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
			const gpu = String(gl.getParameter(param));
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
		})();
		const renderer = new WebGLRenderer({
			antialias: !isSoftwareGl,
			powerPreference: "high-performance",
			preserveDrawingBuffer: true
		});
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.toneMapping = 4;
		renderer.toneMappingExposure = 1.12;
		renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
		renderer.shadowMap.enabled = !isSoftwareGl;
		renderer.shadowMap.type = 2;
		const width = container.clientWidth || 500;
		const height = container.clientHeight || 380;
		renderer.setSize(width, height);
		container.innerHTML = "";
		container.appendChild(renderer.domElement);
		const scene = new Scene();
		scene.background = new Color(856863);
		const pmremGenerator = new PMREMGenerator(renderer);
		scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), .04).texture;
		pmremGenerator.dispose();
		const camera = new PerspectiveCamera(36, width / height, 1, 1e3);
		camera.position.set(95, 78, 105);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = !isSoftwareGl;
		controls.dampingFactor = .08;
		controls.maxDistance = 320;
		controls.minDistance = 35;
		controls.mouseButtons = {
			LEFT: MOUSE.ROTATE,
			MIDDLE: MOUSE.ROTATE,
			RIGHT: MOUSE.PAN
		};
		const hemiLight = new HemisphereLight(14412542, 1976635, .85);
		scene.add(hemiLight);
		const keyLight = new DirectionalLight(16775149, 1.65);
		keyLight.position.set(80, 120, 90);
		keyLight.castShadow = !isSoftwareGl;
		keyLight.shadow.mapSize.set(1024, 1024);
		keyLight.shadow.camera.left = -70;
		keyLight.shadow.camera.right = 70;
		keyLight.shadow.camera.top = 70;
		keyLight.shadow.camera.bottom = -70;
		keyLight.shadow.bias = -5e-4;
		keyLight.shadow.normalBias = .02;
		scene.add(keyLight);
		const rimLight = new DirectionalLight(3718648, .75);
		rimLight.position.set(-90, 50, -80);
		scene.add(rimLight);
		const shadowPlane = new Mesh(new PlaneGeometry(140, 140), new MeshBasicMaterial({
			color: 461586,
			transparent: true,
			opacity: .38,
			depthWrite: false
		}));
		shadowPlane.rotation.x = -Math.PI / 2;
		shadowPlane.position.y = -32;
		scene.add(shadowPlane);
		const modelGroup = new Group();
		scene.add(modelGroup);
		let mainSolidMaterial = null;
		let mainEdgesMaterial = null;
		const buildCSGModel = () => {
			while (modelGroup.children.length > 0) {
				const ch: any = modelGroup.children[0];
				if (ch.geometry) ch.geometry.dispose();
				modelGroup.remove(ch);
			}
			const rawPrimitives = stateRef.current.primitives;
			if (!rawPrimitives || rawPrimitives.length === 0) return;
			const isFinitePrim = (p: any) => {
				if (!p || !Number.isFinite(p.xMin) || !Number.isFinite(p.xMax) || !Number.isFinite(p.yMin) || !Number.isFinite(p.yMax) || !Number.isFinite(p.zMin) || !Number.isFinite(p.zMax)) return false;
				if (p.xMax - p.xMin <= .05 || p.yMax - p.yMin <= .05 || p.zMax - p.zMin <= .05) return false;
				if (p.shape === "prism" || p.shape === "pyramid") {
					const poly = p.prismPolygon || p.polygon2D;
					if (!Array.isArray(poly) || poly.length < 3 || !poly.every((pt: any) => pt && Number.isFinite(pt.u) && Number.isFinite(pt.v))) return false;
				}
				return true;
			};
			const basePrims = rawPrimitives.filter((p: any) => isFinitePrim(p) && p.operation !== "subtract");
			const baseBounds = basePrims.length > 0 ? {
				xMin: Math.min(...basePrims.map((p: any) => p.xMin)),
				xMax: Math.max(...basePrims.map((p: any) => p.xMax)),
				yMin: Math.min(...basePrims.map((p: any) => p.yMin)),
				yMax: Math.max(...basePrims.map((p: any) => p.yMax)),
				zMin: Math.min(...basePrims.map((p: any) => p.zMin)),
				zMax: Math.max(...basePrims.map((p: any) => p.zMax))
			} : null;
			const activePrimitives = rawPrimitives.filter((p: any) => {
				if (!isFinitePrim(p)) return false;
				if (p.operation === "subtract" && p.shape === "box" && baseBounds) {
					const coversAllX = p.xMin <= baseBounds.xMin + 1.5 && p.xMax >= baseBounds.xMax - 1.5;
					const coversAllY = p.yMin <= baseBounds.yMin + 1.5 && p.yMax >= baseBounds.yMax - 1.5;
					const coversAllZ = p.zMin <= baseBounds.zMin + 1.5 && p.zMax >= baseBounds.zMax - 1.5;
					if (coversAllX && coversAllY && coversAllZ) return false;
				}
				return true;
			});
			if (activePrimitives.length === 0) return;
			const isXRay = stateRef.current.xRayMode;
			const matCfg = MATERIAL_PRESETS[stateRef.current.materialPreset] || MATERIAL_PRESETS.steel;
			mainSolidMaterial = new MeshPhysicalMaterial({
				color: matCfg.color,
				metalness: matCfg.metalness,
				roughness: matCfg.roughness,
				clearcoat: matCfg.clearcoat,
				clearcoatRoughness: .2,
				flatShading: false,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
				transparent: isXRay,
				opacity: isXRay ? .42 : 1,
				depthWrite: !isXRay,
				side: 2
			});
			mainEdgesMaterial = new LineBasicMaterial({
				color: matCfg.edgeColor,
				transparent: true,
				opacity: isXRay ? .9 : .75
			});
			try {
				const evaluator = new Evaluator();
				let resultBrush: any = null;
				let primaryAddBrush: any = null;
				const fallbackAddGeoms: BufferGeometry[] = [];
				const seenAddPrims: any[] = [];
				for (const rawPrim of activePrimitives) {
					try {
						let prim = rawPrim;
						// Rule 3.1: Apply 0.05mm axial micro-penetration for coplanar touching add primitives
						if (prim.operation === "add" && seenAddPrims.length > 0) {
							prim = { ...rawPrim };
							for (const prev of seenAddPrims) {
								if (Math.abs(prim.xMin - prev.xMax) <= 0.25) prim.xMin -= 0.05;
								if (Math.abs(prim.xMax - prev.xMin) <= 0.25) prim.xMax += 0.05;
								if (Math.abs(prim.yMin - prev.yMax) <= 0.25) prim.yMin -= 0.05;
								if (Math.abs(prim.yMax - prev.yMin) <= 0.25) prim.yMax += 0.05;
								if (Math.abs(prim.zMin - prev.zMax) <= 0.25) prim.zMin -= 0.05;
								if (Math.abs(prim.zMax - prev.zMin) <= 0.25) prim.zMax += 0.05;
							}
						}
						if (prim.operation === "add") seenAddPrims.push(rawPrim);
						const geom = createPrimitiveGeometry(prim);
						const posAttr: any = geom?.getAttribute("position");
						if (!posAttr || posAttr.count < 3 || !Number.isFinite(posAttr.getX(0))) {
							geom?.dispose?.();
							continue;
						}
						const brush = new Brush(geom);
						brush.updateMatrixWorld();
						if (!primaryAddBrush && prim.operation === "add") {
							primaryAddBrush = brush;
						}
						if (!resultBrush) {
							if (prim.operation !== "subtract") resultBrush = brush;
						} else {
							const op = prim.operation === "subtract" ? 1 : prim.operation === "intersect" ? 3 : 0;
							const nextBrush = evaluator.evaluate(resultBrush, brush, op);
							const nextPos: any = nextBrush?.geometry?.getAttribute("position");
							if (nextBrush && nextPos && nextPos.count >= 3 && Number.isFinite(nextPos.getX(0))) {
								resultBrush = nextBrush;
							} else if (prim.operation === "add") {
								fallbackAddGeoms.push(geom);
							}
						}
					} catch {
						if (rawPrim.operation === "add") {
							try {
								fallbackAddGeoms.push(createPrimitiveGeometry(rawPrim));
							} catch {
								// ignore
							}
						}
					}
				}
				if ((!resultBrush || !resultBrush.geometry || (resultBrush.geometry.getAttribute("position")?.count ?? 0) < 3) && primaryAddBrush) {
					resultBrush = primaryAddBrush;
				}
				if (resultBrush && resultBrush.geometry && resultBrush.geometry.getAttribute("position")?.count >= 3) {
					resultBrush.geometry.computeVertexNormals();
					const csgMesh = new Mesh(resultBrush.geometry, mainSolidMaterial);
					csgMesh.castShadow = !isSoftwareGl;
					csgMesh.receiveShadow = !isSoftwareGl;
					csgMesh.renderOrder = 1;
					modelGroup.add(csgMesh);
					const edgesLine = new LineSegments(extractCleanFeatureEdges(resultBrush.geometry, 35), mainEdgesMaterial);
					edgesLine.renderOrder = 2;
					modelGroup.add(edgesLine);
					for (const fbGeom of fallbackAddGeoms) {
						fbGeom.computeVertexNormals();
						const fbMesh = new Mesh(fbGeom, mainSolidMaterial);
						fbMesh.castShadow = !isSoftwareGl;
						fbMesh.receiveShadow = !isSoftwareGl;
						fbMesh.renderOrder = 1;
						modelGroup.add(fbMesh);
						const fbEdges = new LineSegments(extractCleanFeatureEdges(fbGeom, 35), mainEdgesMaterial);
						fbEdges.renderOrder = 2;
						modelGroup.add(fbEdges);
					}
				} else {
					for (const prim of basePrims) {
						const m = new Mesh(createPrimitiveGeometry(prim), mainSolidMaterial);
						modelGroup.add(m);
					}
				}
			} catch {
				for (const prim of basePrims) {
					const m = new Mesh(createPrimitiveGeometry(prim), mainSolidMaterial);
					modelGroup.add(m);
				}
			}
		};
		rebuildModelRef.current = buildCSGModel;
		buildCSGModel();
		if (!isSoftwareGl) renderer.compile(scene, camera);
		let frameId = 0;
		let renderBusy = false;
		let renderDirty = false;
		const clock = new Clock();
		function afterDraw(cb) {
			const gl: any = renderer.getContext();
			const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
			gl.flush();
			if (!sync) {
				frameId = window.setTimeout(cb, 80);
				return;
			}
			const poll = () => {
				if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.UNSIGNALED) frameId = window.setTimeout(poll, 5);
				else {
					gl.deleteSync(sync);
					frameId = window.setTimeout(cb, 80);
				}
			};
			frameId = window.setTimeout(poll, 5);
		}
		function requestRender() {
			if (renderBusy) {
				renderDirty = true;
				return;
			}
			renderBusy = true;
			frameId = requestAnimationFrame(() => {
				renderDirty = false;
				const dt = Math.min(clock.getDelta(), .1) || .016;
				const st = stateRef.current;
				const isXRay = st.xRayMode;
				const matCfg = MATERIAL_PRESETS[st.materialPreset] || MATERIAL_PRESETS.steel;
				if (mainSolidMaterial) {
					mainSolidMaterial.color.setHex(matCfg.color);
					mainSolidMaterial.metalness = matCfg.metalness;
					mainSolidMaterial.roughness = matCfg.roughness;
					mainSolidMaterial.clearcoat = matCfg.clearcoat;
					mainSolidMaterial.transparent = isXRay;
					mainSolidMaterial.opacity = isXRay ? .42 : 1;
					mainSolidMaterial.depthWrite = !isXRay;
					mainSolidMaterial.side = 2;
					mainSolidMaterial.needsUpdate = true;
				}
				if (mainEdgesMaterial) {
					mainEdgesMaterial.color.setHex(matCfg.edgeColor);
					mainEdgesMaterial.transparent = true;
					mainEdgesMaterial.opacity = isXRay ? .9 : .75;
				}
				let stillMoving = false;
				if (st.cameraTransitioning) {
					const k = 1 - Math.exp(-8 * dt);
					camera.position.lerp(st.desiredCamPos, k);
					controls.target.lerp(st.desiredTarget, k);
					if (camera.position.distanceTo(st.desiredCamPos) < .4) {
						camera.position.copy(st.desiredCamPos);
						st.cameraTransitioning = false;
					} else stillMoving = true;
				}
				controls.update();
				renderer.render(scene, camera);
				const done = () => {
					renderBusy = false;
					if (renderDirty || stillMoving) requestRender();
				};
				if (isSoftwareGl) afterDraw(done);
				else done();
			});
		}
		requestRenderRef.current = requestRender;
		const onControlStart = () => {
			stateRef.current.cameraTransitioning = false;
		};
		const onControlChange = () => {
			requestRender();
		};
		controls.addEventListener("start", onControlStart);
		controls.addEventListener("change", onControlChange);
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width: cw, height: ch } = entry.contentRect;
				if (cw > 0 && ch > 0) {
					camera.aspect = cw / ch;
					camera.updateProjectionMatrix();
					renderer.setSize(cw, ch);
					requestRender();
				}
			}
		});
		resizeObserver.observe(container);
		requestRender();
		return () => {
			cancelAnimationFrame(frameId);
			clearTimeout(frameId);
			resizeObserver.disconnect();
			controls.removeEventListener("start", onControlStart);
			controls.removeEventListener("change", onControlChange);
			controls.dispose();
			renderer.dispose();
		};
	}, []);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative w-full h-full bg-[#0D131F] overflow-hidden select-none",
		onContextMenu: (e) => {
			e.preventDefault();
			e.stopPropagation();
		},
		onMouseDown: (e) => {
			if (e.button === 1) e.preventDefault();
		},
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				ref: mountRef,
				className: "w-full h-full"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "absolute top-2.5 left-3 z-10 flex items-center bg-[#111827]/90 border border-[#263244] rounded p-0.5 gap-0.5",
				children: [
					[
						{
							id: "front",
							label: labels.front
						},
						{
							id: "left",
							label: labels.left
						},
						{
							id: "top",
							label: labels.top
						},
						{
							id: "iso",
							label: labels.iso
						}
					].map((btn) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: () => triggerCameraView(btn.id),
						className: `px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${activePreset === btn.id ? "bg-[#0284C7] text-white" : "text-[#94A3B8] hover:text-white hover:bg-[#1E293B]"}`,
						children: btn.label
					}, btn.id)),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "w-[1px] h-3.5 bg-[#263244] mx-0.5" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: onToggleXRay,
						className: `px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${xRayMode ? "bg-[#D97706] text-white" : "text-[#94A3B8] hover:text-white hover:bg-[#1E293B]"}`,
						children: labels.xray
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "absolute top-2.5 right-3 z-10",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					onClick: onToggleFullscreen,
					className: "p-1.5 rounded bg-[#111827]/90 border border-[#263244] text-[#94A3B8] hover:text-white hover:bg-[#1E293B] transition-colors",
					title: isFullscreen ? labels.exitFullscreen : labels.fullscreen,
					children: isFullscreen ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Minimize2, { className: "w-3.5 h-3.5" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Maximize2, { className: "w-3.5 h-3.5" })
				})
			})
		]
	});
};
