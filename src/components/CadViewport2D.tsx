import * as import_react from "react";
import * as import_jsx_runtime from "react/jsx-runtime";
import {
  applyGripDrag,
  computeCircleTangentPoint,
  computeOSnap,
  dist2D,
  expandEntityToSegments,
  extendEntityAtPoint,
  findHoveredEntity,
  getEntitiesInSelectionBox,
  getEntityGrips,
  normalizeAngle,
  offsetEntityAtPoint,
  translateEntity,
  trimEntityAtPoint,
} from "../utils/geometryKernel";

// src/components/CadViewport2D.tsx
var BASE_BOTTOM_OFFSET = 52;
var BASE_TOP_OFFSET = 26;
var sharedCadClipboard: {
	entities: any[];
	sourceView: string;
	pasteCount: number;
} = {
	entities: [],
	sourceView: "front",
	pasteCount: 0
};
export const CadViewport2D: any = ({
	view,
	title,
	axisLabels,
	entities,
	onChangeEntities,
	activeTool,
	onSwitchToSelect,
	activeLineType,
	onChangeActiveLineType = (_lt?: any) => {},
	enabledSnaps,
	orthoEnabled,
	gridStep,
	polygonSides,
	offsetDistance,
	snapTolerance = 11,
	showDynamicHUD = true,
	showAlignmentRays = true,
	sharedCursor,
	onUpdateSharedCursor,
	hoveredFeatureId,
	onHoverFeature,
	showProjectionSteps,
	projectionSteps,
	activeStepIndex,
	diagnostics,
	zoom,
	pan,
	onChangeViewportTransform
}) => {
	const canvasRef = (0, import_react.useRef)(null);
	const containerRef = (0, import_react.useRef)(null);
	const [isPanning, setIsPanning] = (0, import_react.useState)(false);
	const panStartRef = (0, import_react.useRef)({
		x: 0,
		y: 0,
		px: 0,
		py: 0,
		moved: false
	});
	const [drawStart, setDrawStart] = (0, import_react.useState)(null);
	const [drawStartCircle, setDrawStartCircle] = (0, import_react.useState)(null);
	const [arcStartPt, setArcStartPt] = (0, import_react.useState)(null);
	const [currentSnap, setCurrentSnap] = (0, import_react.useState)(null);
	const [hoveredEntityId, setHoveredEntityId] = (0, import_react.useState)(null);
	const [hoveredGripId, setHoveredGripId] = (0, import_react.useState)(null);
	const lastRawWorldRef = (0, import_react.useRef)(null);
	const dragHistoryRecordedRef = (0, import_react.useRef)(false);
	const [selectedIds, setSelectedIds] = (0, import_react.useState)([]);
	const [selectionBox, setSelectionBox] = (0, import_react.useState)(null);
	const [dragState, setDragState] = (0, import_react.useState)(null);
	(0, import_react.useEffect)(() => {
		setDrawStart(null);
		setDrawStartCircle(null);
		setArcStartPt(null);
		setSelectionBox(null);
		setDragState(null);
		dragHistoryRecordedRef.current = false;
	}, [activeTool]);
	/**
	* DPI-Safe World -> Screen Transform (Always uses CSS pixel height `cssHeight`, never `canvas.height * dpr`)
	* Also keeps `pan.y` positive downward in ALL views so middle-click dragging matches mouse direction 1:1.
	*/
	const worldToScreen = (u, v, cssHeight) => {
		return {
			x: pan.x + u * zoom,
			y: (view === "top" ? BASE_TOP_OFFSET + v * zoom : cssHeight - BASE_BOTTOM_OFFSET - v * zoom) + pan.y
		};
	};
	/**
	* DPI-Safe Screen -> World Inverse Transform (Exact mathematical inverse of `worldToScreen`)
	*/
	const screenToWorld = (sx, sy, cssHeight) => {
		return {
			u: (sx - pan.x) / zoom,
			v: view === "top" ? (sy - pan.y - BASE_TOP_OFFSET) / zoom : (cssHeight - BASE_BOTTOM_OFFSET - (sy - pan.y)) / zoom
		};
	};
	/**
	* Angle / Ortho Locking:
	* - When holding Shift while pulling a line (`activeTool === 'line'` or dragging a line endpoint grip),
	*   locks the direction to the nearest multiple of 45° (0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°).
	* - When `orthoEnabled` [F8] is on (without Shift), locks to 90° horizontal/vertical.
	* - Otherwise allows free 360° line drawing.
	*/
	const applyOrtho = (start, pt, shiftKey, rawWorldPt) => {
		if (!start) return pt;
		if (!(activeTool === "line" || activeTool === "select" && dragState?.mode === "grip")) return pt;
		const refPt = rawWorldPt || pt;
		const rawDu = refPt.u - start.u;
		const rawDv = refPt.v - start.v;
		const du = pt.u - start.u;
		const dv = pt.v - start.v;
		if (Math.hypot(rawDu, rawDv) < 1e-4 && Math.hypot(du, dv) < 1e-4) return pt;
		if (shiftKey) {
			const snappedIdx = (Math.round(Math.atan2(Math.hypot(rawDu, rawDv) >= 1e-4 ? rawDv : dv, Math.hypot(rawDu, rawDv) >= 1e-4 ? rawDu : du) / (Math.PI / 4)) % 8 + 8) % 8;
			if (snappedIdx === 0 || snappedIdx === 4) return {
				u: Number(pt.u.toFixed(2)),
				v: start.v
			};
			if (snappedIdx === 2 || snappedIdx === 6) return {
				u: start.u,
				v: Number(pt.v.toFixed(2))
			};
			const signU = snappedIdx === 1 || snappedIdx === 7 ? 1 : -1;
			const signV = snappedIdx === 1 || snappedIdx === 3 ? 1 : -1;
			if (du * signU >= 0 && dv * signV >= 0 && Math.abs(Math.abs(du) - Math.abs(dv)) < .05) {
				const exactDelta = Number(((Math.abs(du) + Math.abs(dv)) / 2).toFixed(2));
				return {
					u: Number((start.u + signU * exactDelta).toFixed(2)),
					v: Number((start.v + signV * exactDelta).toFixed(2))
				};
			}
			const projDelta = Math.max(0, (du * signU + dv * signV) / 2);
			const diagDelta = Number(projDelta.toFixed(1));
			return {
				u: Number((start.u + signU * diagDelta).toFixed(1)),
				v: Number((start.v + signV * diagDelta).toFixed(1))
			};
		}
		if (orthoEnabled) {
			if (Math.abs(du) >= Math.abs(dv)) return {
				u: Number(pt.u.toFixed(2)),
				v: start.v
			};
			return {
				u: start.u,
				v: Number(pt.v.toFixed(2))
			};
		}
		return pt;
	};
	const [clipboardBanner, setClipboardBanner] = (0, import_react.useState)<string | null>(null);
	const handleCopySelected = (0, import_react.useCallback)(() => {
		if (selectedIds.length === 0) return false;
		const selSet = new Set(selectedIds);
		const picked = entities.filter((ent) => ent.view === view && selSet.has(ent.id));
		if (picked.length === 0) return false;
		sharedCadClipboard = {
			entities: JSON.parse(JSON.stringify(picked)),
			sourceView: view,
			pasteCount: 0
		};
		setClipboardBanner(`已复制 ${picked.length} 个图元`);
		window.setTimeout(() => setClipboardBanner(null), 1500);
		return true;
	}, [selectedIds, entities, view]);
	const handlePasteClipboard = (0, import_react.useCallback)(() => {
		if (!sharedCadClipboard.entities || sharedCadClipboard.entities.length === 0) return false;
		sharedCadClipboard.pasteCount += 1;
		const stepOffset = Math.max(2, gridStep) * sharedCadClipboard.pasteCount;
		const now = Date.now();
		const pastedEntities = sharedCadClipboard.entities.map((ent, idx) => {
			const shifted = translateEntity(ent, stepOffset, stepOffset);
			return {
				...shifted,
				id: `${view}-${ent.type}-paste-${now}-${idx}`,
				view,
				source: "user"
			};
		});
		onChangeEntities([...entities, ...pastedEntities]);
		onSwitchToSelect();
		setSelectedIds(pastedEntities.map((e) => e.id));
		setClipboardBanner(`已粘贴 ${pastedEntities.length} 个图元`);
		window.setTimeout(() => setClipboardBanner(null), 1500);
		return true;
	}, [gridStep, view, entities, onChangeEntities, onSwitchToSelect]);
	const handleBatchSetLineType = (0, import_react.useCallback)((nextLt: string) => {
		onChangeActiveLineType(nextLt);
		if (selectedIds.length === 0) return;
		const selSet = new Set(selectedIds);
		let changed = false;
		const updated = entities.map((ent) => {
			if (ent.view === view && selSet.has(ent.id) && ent.lineType !== nextLt) {
				changed = true;
				return {
					...ent,
					lineType: nextLt,
					source: "user"
				};
			}
			return ent;
		});
		if (changed) onChangeEntities(updated);
	}, [selectedIds, entities, view, onChangeEntities, onChangeActiveLineType]);
	(0, import_react.useEffect)(() => {
		const onKeyDown = (e) => {
			if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
			if ((e.ctrlKey || e.metaKey) && !e.altKey) {
				const k = e.key.toLowerCase();
				if (k === "z" || k === "y") {
					setDrawStart(null);
					setDrawStartCircle(null);
					setArcStartPt(null);
					setSelectionBox(null);
					setDragState(null);
					dragHistoryRecordedRef.current = false;
					return;
				}
				if (k === "c" && selectedIds.length > 0) {
					e.preventDefault();
					handleCopySelected();
					return;
				}
				if (k === "v" && sharedCadClipboard.entities.length > 0) {
					const isTargetView = sharedCursor.activeView ? sharedCursor.activeView === view : sharedCadClipboard.sourceView === view;
					if (isTargetView) {
						e.preventDefault();
						handlePasteClipboard();
					}
					return;
				}
				if (k === "a") {
					const isTargetView = sharedCursor.activeView ? sharedCursor.activeView === view : view === "front";
					if (isTargetView) {
						e.preventDefault();
						const allInView = entities.filter((ent) => ent.view === view).map((ent) => ent.id);
						onSwitchToSelect();
						setSelectedIds(allInView);
					}
					return;
				}
			}
			if (!e.ctrlKey && !e.metaKey && !e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
				const ltMap: Record<string, string> = {
					"1": "thick_solid",
					"2": "thin_dashed",
					"3": "center_dot_dash",
					"4": "construction"
				};
				const nextLt = ltMap[e.key];
				if (nextLt && selectedIds.length > 0) {
					e.preventDefault();
					handleBatchSetLineType(nextLt);
					return;
				}
			}
			if (e.key === "Escape") {
				setDrawStart(null);
				setDrawStartCircle(null);
				setArcStartPt(null);
				setSelectionBox(null);
				setDragState(null);
				dragHistoryRecordedRef.current = false;
				setSelectedIds([]);
			} else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.length > 0) {
				e.preventDefault();
				const delSet = new Set(selectedIds);
				onChangeEntities(entities.filter((ent) => !delSet.has(ent.id)));
				setSelectedIds([]);
			} else if ((e.key === "Enter" || e.key === " ") && drawStart) {
				e.preventDefault();
				setDrawStart(null);
				setDrawStartCircle(null);
				setArcStartPt(null);
			} else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "f" || e.key === "F")) {
				e.preventDefault();
				onChangeViewportTransform(3, { x: 36, y: 0 });
			} else if (e.key === "Shift" && drawStart && lastRawWorldRef.current) {
				const snap = computeOSnap(lastRawWorldRef.current, view, entities, enabledSnaps, gridStep, snapTolerance / zoom, void 0, drawStart);
				const finalPt = applyOrtho(drawStart, snap.point, true, lastRawWorldRef.current);
				setCurrentSnap({
					...snap,
					point: finalPt
				});
			}
		};
		const onKeyUp = (e) => {
			if (e.key === "Shift" && drawStart && lastRawWorldRef.current) {
				const snap = computeOSnap(lastRawWorldRef.current, view, entities, enabledSnaps, gridStep, snapTolerance / zoom, void 0, drawStart);
				const finalPt = applyOrtho(drawStart, snap.point, false, lastRawWorldRef.current);
				setCurrentSnap({
					...snap,
					point: finalPt
				});
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, [
		selectedIds,
		entities,
		onChangeEntities,
		drawStart,
		view,
		enabledSnaps,
		gridStep,
		zoom,
		activeTool,
		orthoEnabled,
		sharedCursor.activeView,
		handleCopySelected,
		handlePasteClipboard,
		handleBatchSetLineType
	]);
	const activeGrips = import_react.useMemo(() => {
		if (activeTool !== "select" || selectedIds.length === 0) return [];
		const selSet = new Set(selectedIds);
		const grips = [];
		for (const ent of entities) if (ent.view === view && selSet.has(ent.id)) grips.push(...getEntityGrips(ent));
		return grips;
	}, [
		activeTool,
		selectedIds,
		entities,
		view
	]);
	const findHitGrip = (worldPt, tolWorld) => {
		let best = null;
		for (const g of activeGrips) {
			const d = dist2D(worldPt, g.point);
			if (d <= tolWorld && (!best || d < best.d)) best = {
				grip: g,
				d
			};
		}
		return best ? best.grip : null;
	};
	const handlePointerMove = (e) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const cssHeight = rect.height || 300;
		if (isPanning) {
			const dx = sx - panStartRef.current.x;
			const dy = sy - panStartRef.current.y;
			if (Math.hypot(dx, dy) > 3) panStartRef.current.moved = true;
			if (panStartRef.current.moved) onChangeViewportTransform(zoom, {
				x: panStartRef.current.px + dx,
				y: panStartRef.current.py + dy
			});
			return;
		}
		const rawWorld = screenToWorld(sx, sy, cssHeight);
		lastRawWorldRef.current = rawWorld;
		const excludeIds = dragState?.mode === "grip" ? /* @__PURE__ */ new Set([dragState.entityId]) : dragState?.mode === "move" ? new Set(dragState.selectedIds) : void 0;
		let activeAnchorPt = drawStart;
		if (!activeAnchorPt && dragState?.mode === "grip") {
			const draggedEnt = dragState.initialEntities.find((item) => item.id === dragState.entityId);
			if (draggedEnt && draggedEnt.type === "line") activeAnchorPt = dragState.gripId === "p1" ? draggedEnt.p2 : dragState.gripId === "p2" ? draggedEnt.p1 : null;
		}
		const snap = computeOSnap(rawWorld, view, entities, enabledSnaps, gridStep, snapTolerance / zoom, excludeIds, activeAnchorPt);
		const finalPt = applyOrtho(activeAnchorPt, snap.point, e.shiftKey, rawWorld);
		setCurrentSnap({
			...snap,
			point: finalPt
		});
		if (view === "front") onUpdateSharedCursor({
			x: finalPt.u,
			y: sharedCursor.y,
			z: finalPt.v,
			activeView: "front"
		});
		else if (view === "top") onUpdateSharedCursor({
			x: finalPt.u,
			y: finalPt.v,
			z: sharedCursor.z,
			activeView: "top"
		});
		else onUpdateSharedCursor({
			x: sharedCursor.x,
			y: finalPt.u,
			z: finalPt.v,
			activeView: "left"
		});
		if (dragState) {
			const replaceLast = dragHistoryRecordedRef.current;
			dragHistoryRecordedRef.current = true;
			if (dragState.mode === "grip") onChangeEntities(dragState.initialEntities.map((ent) => ent.id === dragState.entityId ? applyGripDrag(ent, dragState.gripId, finalPt) : ent), { replaceLast });
			else if (dragState.mode === "move") {
				let du = finalPt.u - dragState.startWorld.u;
				let dv = finalPt.v - dragState.startWorld.v;
				if (e.shiftKey) {
					if (Math.abs(du) >= Math.abs(dv)) dv = 0;
					else du = 0;
				}
				const moveSet = new Set(dragState.selectedIds);
				onChangeEntities(dragState.initialEntities.map((ent) => ent.view === view && moveSet.has(ent.id) ? translateEntity(ent, du, dv) : ent), { replaceLast });
			}
			return;
		}
		if (selectionBox) {
			setSelectionBox({
				...selectionBox,
				currentScreen: {
					x: sx,
					y: sy
				},
				currentWorld: rawWorld
			});
			return;
		}
		if (activeTool === "select") {
			const hitGrip = findHitGrip(rawWorld, 9 / zoom);
			setHoveredGripId(hitGrip ? `${hitGrip.entityId}:${hitGrip.id}` : null);
		} else setHoveredGripId(null);
		const hovered = findHoveredEntity(rawWorld, view, entities, 9 / zoom);
		setHoveredEntityId(hovered ? hovered.id : null);
		if (hovered?.featureId) onHoverFeature(hovered.featureId);
		else if (hoveredEntityId) onHoverFeature(null);
	};
	const handlePointerDown = (e) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const cssHeight = rect.height || 300;
		if (e.button === 1 || e.button === 2 || activeTool === "pan") {
			e.preventDefault();
			e.stopPropagation();
			try {
				e.currentTarget.setPointerCapture(e.pointerId);
			} catch {}
			setIsPanning(true);
			panStartRef.current = {
				x: sx,
				y: sy,
				px: pan.x,
				py: pan.y,
				moved: false
			};
			return;
		}
		const rawWorld = screenToWorld(sx, sy, cssHeight);
		lastRawWorldRef.current = rawWorld;
		const snap = computeOSnap(rawWorld, view, entities, enabledSnaps, gridStep, snapTolerance / zoom, void 0, drawStart);
		const pt = applyOrtho(drawStart, snap.point, e.shiftKey, rawWorld);
		if (activeTool === "select") {
			const hitGrip = findHitGrip(rawWorld, 9 / zoom);
			if (hitGrip) {
				dragHistoryRecordedRef.current = false;
				setDragState({
					mode: "grip",
					entityId: hitGrip.entityId,
					gripId: hitGrip.id,
					startWorld: hitGrip.point,
					initialEntities: entities
				});
				return;
			}
			const hovered = findHoveredEntity(rawWorld, view, entities, 9 / zoom);
			if (hovered) {
				onHoverFeature(hovered.featureId || null);
				let nextSelected = selectedIds;
				if (e.shiftKey) nextSelected = selectedIds.includes(hovered.id) ? selectedIds.filter((id) => id !== hovered.id) : [...selectedIds, hovered.id];
				else if (!selectedIds.includes(hovered.id)) nextSelected = [hovered.id];
				setSelectedIds(nextSelected);
				dragHistoryRecordedRef.current = false;
				setDragState({
					mode: "move",
					startWorld: snap.point,
					selectedIds: nextSelected,
					initialEntities: entities
				});
				return;
			}
			setSelectionBox({
				startScreen: {
					x: sx,
					y: sy
				},
				currentScreen: {
					x: sx,
					y: sy
				},
				startWorld: rawWorld,
				currentWorld: rawWorld
			});
			return;
		}
		if (activeTool === "erase") {
			const hovered = findHoveredEntity(rawWorld, view, entities, 10 / zoom);
			if (hovered) {
				onChangeEntities(entities.filter((item) => item.id !== hovered.id));
				setSelectedIds((prev) => prev.filter((id) => id !== hovered.id));
			}
			return;
		}
		if (activeTool === "trim") {
			onChangeEntities(trimEntityAtPoint(rawWorld, view, entities));
			return;
		}
		if (activeTool === "extend") {
			onChangeEntities(extendEntityAtPoint(rawWorld, view, entities));
			return;
		}
		if (activeTool === "offset") {
			onChangeEntities(offsetEntityAtPoint(rawWorld, view, entities, offsetDistance));
			return;
		}
		if (!drawStart) {
			if (activeTool === "tangent") {
				const hovered = findHoveredEntity(pt, view, entities, 12 / zoom);
				if (hovered && hovered.type === "circle") setDrawStartCircle(hovered);
			}
			setDrawStart(pt);
			return;
		}
		const newId = `${view}-${activeTool}-${Date.now()}`;
		if (activeTool === "line") {
			if (dist2D(drawStart, pt) > .5) {
				onChangeEntities([...entities, {
					id: newId,
					view,
					type: "line",
					lineType: activeLineType,
					p1: drawStart,
					p2: pt,
					source: "user"
				}]);
				setDrawStart(pt);
			}
		} else if (activeTool === "tangent") {
			let p1 = drawStart;
			let p2 = pt;
			const secondHovered = findHoveredEntity(pt, view, entities, 12 / zoom);
			if (drawStartCircle) p1 = computeCircleTangentPoint(pt, drawStartCircle.center, drawStartCircle.radius, drawStart);
			else if (secondHovered && secondHovered.type === "circle") p2 = computeCircleTangentPoint(drawStart, secondHovered.center, secondHovered.radius, pt);
			if (dist2D(p1, p2) > .5) onChangeEntities([...entities, {
				id: newId,
				view,
				type: "line",
				lineType: activeLineType,
				p1,
				p2,
				source: "user"
			}]);
			setDrawStart(null);
			setDrawStartCircle(null);
		} else if (activeTool === "rect") {
			const x = Math.min(drawStart.u, pt.u);
			const y = Math.min(drawStart.v, pt.v);
			const width = Math.abs(pt.u - drawStart.u);
			const height = Math.abs(pt.v - drawStart.v);
			if (width > 1 && height > 1) onChangeEntities([...entities, {
				id: newId,
				view,
				type: "rect",
				lineType: activeLineType,
				x: Number(x.toFixed(1)),
				y: Number(y.toFixed(1)),
				width: Number(width.toFixed(1)),
				height: Number(height.toFixed(1)),
				source: "user"
			}]);
			setDrawStart(null);
		} else if (activeTool === "circle") {
			const radius = Number(dist2D(drawStart, pt).toFixed(1));
			if (radius >= 1) onChangeEntities([...entities, {
				id: newId,
				view,
				type: "circle",
				lineType: activeLineType,
				center: drawStart,
				radius,
				source: "user"
			}]);
			setDrawStart(null);
		} else if (activeTool === "polygon") {
			const radius = dist2D(drawStart, pt);
			if (radius >= 1.5) {
				const sides = Math.max(3, Math.min(12, polygonSides));
				const baseAngle = Math.atan2(pt.v - drawStart.v, pt.u - drawStart.u);
				const pts = [];
				for (let i = 0; i < sides; i++) {
					const ang = baseAngle + i * Math.PI * 2 / sides;
					pts.push({
						u: Number((drawStart.u + Math.cos(ang) * radius).toFixed(1)),
						v: Number((drawStart.v + Math.sin(ang) * radius).toFixed(1))
					});
				}
				onChangeEntities([...entities, {
					id: newId,
					view,
					type: "polygon",
					lineType: activeLineType,
					points: pts,
					closed: true,
					source: "user"
				}]);
			}
			setDrawStart(null);
		} else if (activeTool === "arc") {
			if (!arcStartPt) {
				if (dist2D(drawStart, pt) >= 1.5) setArcStartPt(pt);
			} else {
				const radius = Number(dist2D(drawStart, arcStartPt).toFixed(1));
				const startAngle = normalizeAngle(Math.atan2(arcStartPt.v - drawStart.v, arcStartPt.u - drawStart.u));
				const endAngle = normalizeAngle(Math.atan2(pt.v - drawStart.v, pt.u - drawStart.u));
				if (radius >= 1.5 && Math.abs(endAngle - startAngle) > .05) onChangeEntities([...entities, {
					id: newId,
					view,
					type: "arc",
					lineType: activeLineType,
					center: drawStart,
					radius,
					startAngle,
					endAngle,
					source: "user"
				}]);
				setDrawStart(null);
				setArcStartPt(null);
			}
		}
	};
	const handlePointerUp = (e) => {
		if (e.button === 2) {
			e.preventDefault();
			e.stopPropagation();
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {}
			const wasDragged = panStartRef.current.moved;
			setIsPanning(false);
			if (!wasDragged) {
				setDrawStartCircle(null);
				setArcStartPt(null);
				setSelectionBox(null);
				setDragState(null);
				dragHistoryRecordedRef.current = false;
				if (activeTool === "line") {
					if (drawStart !== null) setDrawStart(null);
					else onSwitchToSelect();
					return;
				}
				setDrawStart(null);
				if (activeTool !== "select") onSwitchToSelect();
			}
			return;
		}
		setIsPanning(false);
		if (dragState) {
			setDragState(null);
			dragHistoryRecordedRef.current = false;
		}
		if (selectionBox) {
			const dx = selectionBox.currentScreen.x - selectionBox.startScreen.x;
			const dy = selectionBox.currentScreen.y - selectionBox.startScreen.y;
			if (Math.hypot(dx, dy) > 4) {
				const isCrossing = dx < 0;
				const boxHits = getEntitiesInSelectionBox(selectionBox.startWorld, selectionBox.currentWorld, view, entities, isCrossing);
				if (e.shiftKey) {
					const merged = Array.from(/* @__PURE__ */ new Set([...selectedIds, ...boxHits]));
					setSelectedIds(merged);
				} else setSelectedIds(boxHits);
			} else if (!e.shiftKey) setSelectedIds([]);
			setSelectionBox(null);
		}
	};
	/**
	* Wheel Zoom-to-Cursor with exact inverse formula using CSS height `rect.height` (Safeguard 1)
	*/
	const handleWheel = (e) => {
		e.preventDefault();
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const cssHeight = rect.height || 300;
		const worldUnderCursor = screenToWorld(sx, sy, cssHeight);
		const factor = e.deltaY < 0 ? 1.12 : .9;
		const newZoom = Math.max(1.4, Math.min(7.5, Number((zoom * factor).toFixed(2))));
		onChangeViewportTransform(newZoom, {
			x: sx - worldUnderCursor.u * newZoom,
			y: sy - (view === "top" ? BASE_TOP_OFFSET + worldUnderCursor.v * newZoom : cssHeight - BASE_BOTTOM_OFFSET - worldUnderCursor.v * newZoom)
		});
	};
	(0, import_react.useEffect)(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!canvas || !container) return;
		const dpr = window.devicePixelRatio || 1;
		const width = container.clientWidth || 420;
		const height = container.clientHeight || 300;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.save();
		ctx.scale(dpr, dpr);
		ctx.fillStyle = "#0D131F";
		ctx.fillRect(0, 0, width, height);
		const step = Math.max(2, gridStep);
		for (let u = 0; u <= 120; u += step) {
			const p0 = worldToScreen(u, 0, height);
			const p1 = worldToScreen(u, 120, height);
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y);
			ctx.lineTo(p1.x, p1.y);
			ctx.strokeStyle = u % 20 === 0 ? "#1E293B" : "#131C2B";
			ctx.lineWidth = u % 20 === 0 ? 1 : .6;
			ctx.stroke();
			if (u % 20 === 0 && u > 0) {
				ctx.fillStyle = "#475569";
				ctx.font = "10px \"JetBrains Mono\", monospace";
				ctx.fillText(`${u}`, p0.x - 6, view === "top" ? p0.y - 5 : p0.y + 12);
			}
		}
		for (let v = 0; v <= 120; v += step) {
			const p0 = worldToScreen(0, v, height);
			const p1 = worldToScreen(120, v, height);
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y);
			ctx.lineTo(p1.x, p1.y);
			ctx.strokeStyle = v % 20 === 0 ? "#1E293B" : "#131C2B";
			ctx.lineWidth = v % 20 === 0 ? 1 : .6;
			ctx.stroke();
			if (v % 20 === 0 && v > 0) {
				ctx.fillStyle = "#475569";
				ctx.font = "10px \"JetBrains Mono\", monospace";
				ctx.fillText(`${v}`, p0.x - 18, p0.y + 3);
			}
		}
		const orig = worldToScreen(0, 0, height);
		const uEnd = worldToScreen(124, 0, height);
		const vEnd = worldToScreen(0, 124, height);
		ctx.strokeStyle = "#334155";
		ctx.lineWidth = 1.3;
		ctx.beginPath();
		ctx.moveTo(orig.x, orig.y);
		ctx.lineTo(uEnd.x, uEnd.y);
		ctx.moveTo(orig.x, orig.y);
		ctx.lineTo(vEnd.x, vEnd.y);
		ctx.stroke();
		ctx.fillStyle = "#64748B";
		ctx.font = "bold 11px \"JetBrains Mono\", monospace";
		ctx.fillText(axisLabels.u, uEnd.x + 4, uEnd.y + 4);
		ctx.fillText(axisLabels.v, vEnd.x - 4, view === "top" ? vEnd.y + 12 : vEnd.y - 6);
		if (showAlignmentRays) {
			ctx.save();
			ctx.setLineDash([5, 4]);
			ctx.lineWidth = 1.1;
			const alignU = view === "front" || view === "top" ? sharedCursor.x : sharedCursor.y;
			const alignV = view === "front" || view === "left" ? sharedCursor.z : sharedCursor.y;
			if (alignU !== null && alignU >= 0 && alignU <= 125) {
				const pTop = worldToScreen(alignU, 0, height);
				const isYAxis = view === "left";
				ctx.strokeStyle = isYAxis ? "rgba(16, 185, 129, 0.78)" : "rgba(56, 189, 248, 0.72)";
				ctx.beginPath();
				ctx.moveTo(pTop.x, 0);
				ctx.lineTo(pTop.x, height);
				ctx.stroke();
				if (sharedCursor.activeView && sharedCursor.activeView !== view) {
					ctx.fillStyle = isYAxis ? "#10B981" : "#38BDF8";
					ctx.font = "10px \"JetBrains Mono\", monospace";
					ctx.fillText(`${isYAxis ? "Y" : "X"}=${alignU.toFixed(0)}`, pTop.x + 4, view === "top" ? 14 : height - 8);
				}
			}
			if (alignV !== null && alignV >= 0 && alignV <= 125) {
				const pLeft = worldToScreen(0, alignV, height);
				const isYAxis = view === "top";
				ctx.strokeStyle = isYAxis ? "rgba(16, 185, 129, 0.78)" : "rgba(245, 158, 11, 0.72)";
				ctx.beginPath();
				ctx.moveTo(0, pLeft.y);
				ctx.lineTo(width, pLeft.y);
				ctx.stroke();
				if (sharedCursor.activeView && sharedCursor.activeView !== view) {
					ctx.fillStyle = isYAxis ? "#10B981" : "#F59E0B";
					ctx.font = "10px \"JetBrains Mono\", monospace";
					ctx.fillText(`${isYAxis ? "Y" : "Z"}=${alignV.toFixed(0)}`, width - 44, pLeft.y - 4);
				}
			}
			ctx.restore();
		}
		const selectedSet = new Set(selectedIds);
		const applyLineStyle = (lt, isHovered, isSelected, isDerived) => {
			if (isSelected) {
				ctx.strokeStyle = "#22D3EE";
				ctx.lineWidth = 3;
				ctx.setLineDash([]);
				return;
			}
			if (isHovered) {
				ctx.strokeStyle = "#38BDF8";
				ctx.lineWidth = 3;
				ctx.setLineDash([]);
				return;
			}
			if (lt === "thick_solid") {
				ctx.strokeStyle = isDerived ? "#E0F2FE" : "#F8FAFC";
				ctx.lineWidth = 2.4;
				ctx.setLineDash([]);
			} else if (lt === "thin_dashed") {
				ctx.strokeStyle = "#F59E0B";
				ctx.lineWidth = 1.5;
				ctx.setLineDash([7, 4]);
			} else if (lt === "center_dot_dash") {
				ctx.strokeStyle = "#06B6D4";
				ctx.lineWidth = 1.2;
				ctx.setLineDash([
					12,
					3,
					2,
					3
				]);
			} else {
				ctx.strokeStyle = "#10B981";
				ctx.lineWidth = 1;
				ctx.setLineDash([3, 3]);
			}
		};
		const viewEntities = entities.filter((e) => e.view === view);
		for (const ent of viewEntities) {
			const isSelected = selectedSet.has(ent.id);
			const isHovered = ent.id === hoveredEntityId || Boolean(hoveredFeatureId && ent.featureId === hoveredFeatureId);
			ctx.save();
			applyLineStyle(ent.lineType, isHovered, isSelected, ent.source === "derived");
			if (ent.type === "circle") {
				const c = worldToScreen(ent.center.u, ent.center.v, height);
				ctx.beginPath();
				ctx.arc(c.x, c.y, ent.radius * zoom, 0, Math.PI * 2);
				ctx.stroke();
			} else {
				const segs = expandEntityToSegments(ent, 48);
				ctx.beginPath();
				let lastX = NaN;
				let lastY = NaN;
				for (const s of segs) {
					const p1 = worldToScreen(s.p1.u, s.p1.v, height);
					const p2 = worldToScreen(s.p2.u, s.p2.v, height);
					if (Number.isNaN(lastX) || Math.hypot(p1.x - lastX, p1.y - lastY) > .5) ctx.moveTo(p1.x, p1.y);
					ctx.lineTo(p2.x, p2.y);
					lastX = p2.x;
					lastY = p2.y;
				}
				ctx.stroke();
			}
			ctx.restore();
		}
		if (activeTool === "select" && activeGrips.length > 0) {
			ctx.save();
			for (const g of activeGrips) {
				const sp = worldToScreen(g.point.u, g.point.v, height);
				const isGripHovered = hoveredGripId === `${g.entityId}:${g.id}`;
				const sz = isGripHovered ? 5.5 : 4.2;
				ctx.fillStyle = isGripHovered ? "#F59E0B" : g.kind === "center" ? "#10B981" : "#06B6D4";
				ctx.strokeStyle = "#0B0F17";
				ctx.lineWidth = 1.2;
				ctx.fillRect(sp.x - sz, sp.y - sz, sz * 2, sz * 2);
				ctx.strokeRect(sp.x - sz, sp.y - sz, sz * 2, sz * 2);
			}
			ctx.restore();
		}
		for (const issue of diagnostics) {
			if (!issue.highlightCoords) continue;
			for (const hc of issue.highlightCoords) {
				if (hc.view !== view) continue;
				const p1 = worldToScreen(hc.p1.u, hc.p1.v, height);
				const p2 = hc.p2 ? worldToScreen(hc.p2.u, hc.p2.v, height) : p1;
				ctx.save();
				ctx.strokeStyle = "#EF4444";
				ctx.lineWidth = 3;
				ctx.setLineDash([6, 3]);
				ctx.beginPath();
				ctx.moveTo(p1.x, p1.y);
				ctx.lineTo(p2.x, p2.y);
				ctx.stroke();
				const mx = (p1.x + p2.x) / 2;
				const my = (p1.y + p2.y) / 2;
				ctx.fillStyle = "#991B1B";
				ctx.strokeStyle = "#EF4444";
				ctx.lineWidth = 1;
				ctx.setLineDash([]);
				const label = hc.deltaValue ? `Δ${hc.axis}=${hc.deltaValue}` : "!";
				ctx.fillRect(mx - 28, my - 10, 56, 16);
				ctx.strokeRect(mx - 28, my - 10, 56, 16);
				ctx.fillStyle = "#FEE2E2";
				ctx.font = "bold 10px \"JetBrains Mono\", monospace";
				ctx.fillText(label, mx - 22, my + 2);
				ctx.restore();
			}
		}
		if (showProjectionSteps && projectionSteps.length > 0) {
			const stepsToShow = projectionSteps.slice(0, activeStepIndex + 1);
			for (const st of stepsToShow) {
				let pt = null;
				if (st.sourceView1 === view) pt = st.sourcePt1;
				else if (st.sourceView2 === view) pt = st.sourcePt2;
				else if (st.targetView === view) pt = st.targetPt;
				if (pt) {
					const sp = worldToScreen(pt.u, pt.v, height);
					ctx.save();
					ctx.strokeStyle = "#10B981";
					ctx.fillStyle = "#10B981";
					ctx.lineWidth = 1.4;
					ctx.setLineDash([4, 3]);
					ctx.beginPath();
					ctx.moveTo(sp.x, 0);
					ctx.lineTo(sp.x, height);
					ctx.moveTo(0, sp.y);
					ctx.lineTo(width, sp.y);
					ctx.stroke();
					ctx.setLineDash([]);
					ctx.beginPath();
					ctx.arc(sp.x, sp.y, 4.5, 0, Math.PI * 2);
					ctx.fill();
					ctx.fillStyle = "#064E3B";
					ctx.strokeStyle = "#10B981";
					ctx.fillRect(sp.x + 6, sp.y - 16, 48, 15);
					ctx.strokeRect(sp.x + 6, sp.y - 16, 48, 15);
					ctx.fillStyle = "#D1FAE5";
					ctx.font = "bold 10px \"JetBrains Mono\", monospace";
					ctx.fillText(`Step ${st.stepNumber}`, sp.x + 10, sp.y - 5);
					ctx.restore();
				}
			}
		}
		if (drawStart && currentSnap) {
			const p1 = worldToScreen(drawStart.u, drawStart.v, height);
			const p2 = worldToScreen(currentSnap.point.u, currentSnap.point.v, height);
			ctx.save();
			ctx.strokeStyle = "#38BDF8";
			ctx.lineWidth = 1.8;
			ctx.setLineDash([5, 3]);
			if (activeTool === "line" || activeTool === "tangent") {
				ctx.beginPath();
				ctx.moveTo(p1.x, p1.y);
				ctx.lineTo(p2.x, p2.y);
				ctx.stroke();
			} else if (activeTool === "rect") ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
			else if (activeTool === "circle") {
				const r = dist2D(drawStart, currentSnap.point) * zoom;
				ctx.beginPath();
				ctx.arc(p1.x, p1.y, r, 0, Math.PI * 2);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(p1.x, p1.y);
				ctx.lineTo(p2.x, p2.y);
				ctx.stroke();
			} else if (activeTool === "polygon") {
				const radius = dist2D(drawStart, currentSnap.point);
				const sides = Math.max(3, Math.min(12, polygonSides));
				const baseAngle = Math.atan2(currentSnap.point.v - drawStart.v, currentSnap.point.u - drawStart.u);
				ctx.beginPath();
				for (let i = 0; i <= sides; i++) {
					const ang = baseAngle + i % sides * Math.PI * 2 / sides;
					const sp = worldToScreen(drawStart.u + Math.cos(ang) * radius, drawStart.v + Math.sin(ang) * radius, height);
					if (i === 0) ctx.moveTo(sp.x, sp.y);
					else ctx.lineTo(sp.x, sp.y);
				}
				ctx.stroke();
			} else if (activeTool === "arc") {
				if (!arcStartPt) {
					const r = dist2D(drawStart, currentSnap.point) * zoom;
					ctx.beginPath();
					ctx.arc(p1.x, p1.y, r, 0, Math.PI * 2);
					ctx.stroke();
				} else {
					const radius = dist2D(drawStart, arcStartPt);
					const startAngle = normalizeAngle(Math.atan2(arcStartPt.v - drawStart.v, arcStartPt.u - drawStart.u));
					const endAngle = normalizeAngle(Math.atan2(currentSnap.point.v - drawStart.v, currentSnap.point.u - drawStart.u));
					const previewSegs = expandEntityToSegments({
						id: "preview-arc",
						view,
						type: "arc",
						lineType: activeLineType,
						center: drawStart,
						radius,
						startAngle,
						endAngle
					}, 36);
					ctx.beginPath();
					for (const s of previewSegs) {
						const sp1 = worldToScreen(s.p1.u, s.p1.v, height);
						const sp2 = worldToScreen(s.p2.u, s.p2.v, height);
						ctx.moveTo(sp1.x, sp1.y);
						ctx.lineTo(sp2.x, sp2.y);
					}
					ctx.stroke();
				}
			}
			ctx.restore();
		}
		if (selectionBox) {
			const { startScreen, currentScreen } = selectionBox;
			const isCrossing = currentScreen.x < startScreen.x;
			const rx = Math.min(startScreen.x, currentScreen.x);
			const ry = Math.min(startScreen.y, currentScreen.y);
			const rw = Math.abs(currentScreen.x - startScreen.x);
			const rh = Math.abs(currentScreen.y - startScreen.y);
			ctx.save();
			if (isCrossing) {
				ctx.fillStyle = "rgba(16, 185, 129, 0.15)";
				ctx.strokeStyle = "#10B981";
				ctx.lineWidth = 1.5;
				ctx.setLineDash([5, 3]);
			} else {
				ctx.fillStyle = "rgba(56, 189, 248, 0.15)";
				ctx.strokeStyle = "#38BDF8";
				ctx.lineWidth = 1.5;
				ctx.setLineDash([]);
			}
			ctx.fillRect(rx, ry, rw, rh);
			ctx.strokeRect(rx, ry, rw, rh);
			ctx.restore();
		}
		if (currentSnap && !selectionBox) {
			const sp = worldToScreen(currentSnap.point.u, currentSnap.point.v, height);
			ctx.save();
			ctx.strokeStyle = "#22D3EE";
			ctx.lineWidth = 1.8;
			const sz = 4.5;
			if (currentSnap.type === "endpoint") ctx.strokeRect(sp.x - sz, sp.y - sz, sz * 2, sz * 2);
			else if (currentSnap.type === "midpoint") {
				ctx.beginPath();
				ctx.moveTo(sp.x, sp.y - sz - 1);
				ctx.lineTo(sp.x - sz - 1, sp.y + sz);
				ctx.lineTo(sp.x + sz + 1, sp.y + sz);
				ctx.closePath();
				ctx.stroke();
			} else if (currentSnap.type === "center") {
				ctx.beginPath();
				ctx.arc(sp.x, sp.y, 5.5, 0, Math.PI * 2);
				ctx.stroke();
			} else if (currentSnap.type === "quadrant") {
				ctx.beginPath();
				ctx.moveTo(sp.x, sp.y - sz - 1);
				ctx.lineTo(sp.x + sz + 1, sp.y);
				ctx.lineTo(sp.x, sp.y + sz + 1);
				ctx.lineTo(sp.x - sz - 1, sp.y);
				ctx.closePath();
				ctx.stroke();
			} else if (currentSnap.type === "intersection") {
				ctx.beginPath();
				ctx.moveTo(sp.x - sz, sp.y - sz);
				ctx.lineTo(sp.x + sz, sp.y + sz);
				ctx.moveTo(sp.x + sz, sp.y - sz);
				ctx.lineTo(sp.x - sz, sp.y + sz);
				ctx.stroke();
			} else {
				ctx.fillStyle = "#38BDF8";
				ctx.fillRect(sp.x - 1.5, sp.y - 1.5, 3, 3);
			}
			if (showDynamicHUD && currentSnap.type !== "grid" && currentSnap.type !== "none") {
				const badgeMap: Record<string, string> = {
					endpoint: "END",
					midpoint: "MID",
					center: "CEN",
					quadrant: "QUAD",
					intersection: "INT"
				};
				const bText = badgeMap[currentSnap.type];
				if (bText) {
					ctx.font = "bold 9px \"JetBrains Mono\", monospace";
					const tw = ctx.measureText(bText).width + 8;
					const bx = Math.min(width - tw - 4, sp.x + 8);
					const by = Math.max(16, sp.y + 14);
					ctx.fillStyle = "rgba(11, 15, 23, 0.9)";
					ctx.strokeStyle = "#22D3EE";
					ctx.lineWidth = 1;
					ctx.fillRect(bx, by - 11, tw, 14);
					ctx.strokeRect(bx, by - 11, tw, 14);
					ctx.fillStyle = "#22D3EE";
					ctx.fillText(bText, bx + 4, by - 1);
				}
			}
			if (showDynamicHUD && drawStart) {
				const p2 = worldToScreen(currentSnap.point.u, currentSnap.point.v, height);
				let hudText = "";
				const du = currentSnap.point.u - drawStart.u;
				const dv = currentSnap.point.v - drawStart.v;
				const dist = Math.hypot(du, dv);
				if (activeTool === "line" || activeTool === "tangent") {
					const deg = (Math.atan2(dv, du) * 180 / Math.PI + 360) % 360;
					hudText = `L=${dist.toFixed(1)}  ∠${deg.toFixed(0)}°`;
				} else if (activeTool === "rect") {
					hudText = `W=${Math.abs(du).toFixed(1)} × H=${Math.abs(dv).toFixed(1)}`;
				} else if (activeTool === "circle") {
					hudText = `Ø${(dist * 2).toFixed(1)} (R${dist.toFixed(1)})`;
				} else if (activeTool === "polygon") {
					hudText = `R=${dist.toFixed(1)} (${polygonSides}N)`;
				} else if (activeTool === "arc") {
					if (!arcStartPt) hudText = `R=${dist.toFixed(1)}`;
					else {
						const r = dist2D(drawStart, arcStartPt);
						const a1 = normalizeAngle(Math.atan2(arcStartPt.v - drawStart.v, arcStartPt.u - drawStart.u));
						const a2 = normalizeAngle(Math.atan2(currentSnap.point.v - drawStart.v, currentSnap.point.u - drawStart.u));
						const sweepDeg = ((a2 - a1 + Math.PI * 2) % (Math.PI * 2)) * 180 / Math.PI;
						hudText = `R=${r.toFixed(1)}  Δ${sweepDeg.toFixed(0)}°`;
					}
				}
				if (hudText) {
					ctx.font = "bold 10px \"JetBrains Mono\", monospace";
					const tw = ctx.measureText(hudText).width + 12;
					const hx = Math.max(6, Math.min(width - tw - 6, p2.x + 12));
					const hy = Math.max(22, p2.y - 12);
					ctx.fillStyle = "rgba(11, 15, 23, 0.92)";
					ctx.strokeStyle = "#38BDF8";
					ctx.lineWidth = 1.1;
					ctx.fillRect(hx, hy - 14, tw, 18);
					ctx.strokeRect(hx, hy - 14, tw, 18);
					ctx.fillStyle = "#F8FAFC";
					ctx.fillText(hudText, hx + 6, hy - 2);
				}
			}
			ctx.restore();
		}
		ctx.restore();
	}, [
		entities,
		view,
		zoom,
		pan,
		gridStep,
		drawStart,
		arcStartPt,
		currentSnap,
		hoveredEntityId,
		hoveredGripId,
		hoveredFeatureId,
		sharedCursor,
		showProjectionSteps,
		projectionSteps,
		activeStepIndex,
		diagnostics,
		activeTool,
		activeLineType,
		polygonSides,
		selectedIds,
		activeGrips,
		selectionBox,
		showDynamicHUD,
		showAlignmentRays
	]);
	const isTransformed = Math.abs(zoom - 3) > .05 || Math.abs(pan.x - 36) > 1 || Math.abs(pan.y) > 1;
	const showActionDock = drawStart !== null || selectedIds.length > 0;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		ref: containerRef,
		className: "relative w-full h-full bg-[#0D131F] overflow-hidden select-none",
		onContextMenu: (e) => {
			e.preventDefault();
			e.stopPropagation();
		},
		onDoubleClick: (e) => {
			if (e.button === 1) {
				e.preventDefault();
				onChangeViewportTransform(3, { x: 36, y: 0 });
			}
		},
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("canvas", {
				ref: canvasRef,
				onPointerMove: handlePointerMove,
				onPointerDown: handlePointerDown,
				onPointerUp: handlePointerUp,
				onPointerLeave: () => {
					setIsPanning(false);
					setCurrentSnap(null);
					setDragState(null);
					setSelectionBox(null);
				},
				onContextMenu: (e) => {
					e.preventDefault();
					e.stopPropagation();
				},
				onWheel: handleWheel,
				className: `w-full h-full block ${isPanning ? "cursor-grabbing" : activeTool === "pan" ? "cursor-grab" : activeTool === "select" && (hoveredGripId || hoveredEntityId) ? "cursor-move" : "cursor-crosshair"}`
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "absolute top-2.5 left-3 pointer-events-none flex items-center gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "px-2 py-0.5 rounded bg-[#111827]/85 border border-[#263244] text-xs font-medium text-[#E2E8F0]",
						children: title
					}),
					clipboardBanner && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "px-2 py-0.5 rounded bg-[#064E3B]/95 border border-[#10B981] text-[11px] font-mono text-[#A7F3D0]",
						children: clipboardBanner
					})
				]
			}),
			isTransformed && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				onClick: () => onChangeViewportTransform(3, { x: 36, y: 0 }),
				title: "Reset Zoom/Pan [F]",
				className: "absolute top-2.5 right-3 px-2 py-0.5 rounded bg-[#111827]/90 hover:bg-[#1E293B] border border-[#263244] text-[10px] font-mono text-[#94A3B8] hover:text-white transition-colors",
				children: `${Math.round(zoom / 3 * 100)}% [F]`
			}),
			showActionDock && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#111827]/95 border border-[#38BDF8]/50 shadow-xl backdrop-blur-md",
				children: [
					drawStart !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: () => {
							setDrawStart(null);
							setDrawStartCircle(null);
							setArcStartPt(null);
						},
						className: "px-2.5 py-1 rounded bg-[#0284C7] hover:bg-[#0369A1] text-[11px] font-medium text-white whitespace-nowrap",
						children: "✓ 结束线段 [Enter]"
					}),
					selectedIds.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, {
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: handleCopySelected,
								className: "px-2 py-0.5 rounded bg-[#16273B] hover:bg-[#1E293B] border border-[#38BDF8]/40 text-[11px] text-[#E0F2FE] whitespace-nowrap",
								children: "复制 [Ctrl+C]"
							}),
							sharedCadClipboard.entities.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: handlePasteClipboard,
								className: "px-2 py-0.5 rounded bg-[#16273B] hover:bg-[#1E293B] border border-[#38BDF8]/40 text-[11px] text-[#E0F2FE] whitespace-nowrap",
								children: "粘贴 [Ctrl+V]"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "w-[1px] h-3.5 bg-[#263244] mx-0.5" }),
							[
								{ k: "1", lt: "thick_solid", label: "1:实" },
								{ k: "2", lt: "thin_dashed", label: "2:虚" },
								{ k: "3", lt: "center_dot_dash", label: "3:点" }
							].map((b) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: () => handleBatchSetLineType(b.lt),
								className: "px-1.5 py-0.5 rounded bg-[#0B0F17] hover:bg-[#1E293B] border border-[#263244] text-[10px] font-mono text-[#CBD5E1] hover:text-white whitespace-nowrap",
								children: b.label
							}, b.k)),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								onClick: () => {
									const delSet = new Set(selectedIds);
									onChangeEntities(entities.filter((ent) => !delSet.has(ent.id)));
									setSelectedIds([]);
								},
								className: "px-2 py-0.5 rounded bg-[#7F1D1D]/70 hover:bg-[#991B1B] border border-[#EF4444]/60 text-[11px] text-[#FEE2E2] whitespace-nowrap",
								children: "删除 [Del]"
							})
						]
					})
				]
			})
		]
	});
};