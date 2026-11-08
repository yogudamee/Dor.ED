import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CadCircleEntity,
  CadEntity,
  DiagnosticIssue,
  LineType,
  Point2D,
  SnapResult,
  SnapType,
  ToolType,
  ViewType,
} from '../types/cad';
import {
  applyGripDrag,
  computeCircleTangentPoint,
  computeOSnap,
  dist2D,
  expandEntityToSegments,
  extendEntityAtPoint,
  findHoveredEntity,
  getEntityGrips,
  normalizeAngle,
  offsetEntityAtPoint,
  translateEntity,
  trimEntityAtPoint,
} from '../utils/geometryKernel';

const TOUCH_OFFSET_PX = 36;

let mobileClipboard: {
  entities: CadEntity[];
  sourceView: ViewType;
  pasteCount: number;
} = {
  entities: [],
  sourceView: 'front',
  pasteCount: 0,
};

export interface MobileCadCanvas2DProps {
  view: ViewType;
  title: string;
  axisLabels: { u: string; v: string };
  entities: CadEntity[];
  onChangeEntities: (next: CadEntity[], options?: any) => void;
  activeTool: ToolType;
  onSwitchToSelect: () => void;
  activeLineType: LineType;
  onChangeActiveLineType: (lt: LineType) => void;
  enabledSnaps: Record<SnapType, boolean>;
  orthoEnabled: boolean;
  gridStep: number;
  polygonSides: number;
  offsetDistance: number;
  snapTolerance: number;
  sharedCursor: {
    x: number | null;
    y: number | null;
    z: number | null;
    activeView: ViewType | null;
  };
  onUpdateSharedCursor: (next: {
    x: number | null;
    y: number | null;
    z: number | null;
    activeView: ViewType | null;
  }) => void;
  onSnapStatusChange?: (snap: SnapResult | null) => void;
  diagnostics: DiagnosticIssue[];
  compact?: boolean;
  onTapCompact?: () => void;
}

export const MobileCadCanvas2D: React.FC<MobileCadCanvas2DProps> = ({
  view,
  title,
  axisLabels,
  entities,
  onChangeEntities,
  activeTool,
  onSwitchToSelect,
  activeLineType,
  onChangeActiveLineType,
  enabledSnaps,
  orthoEnabled,
  gridStep,
  polygonSides,
  offsetDistance,
  snapTolerance,
  sharedCursor,
  onUpdateSharedCursor,
  onSnapStatusChange,
  diagnostics,
  compact = false,
  onTapCompact,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Independent mobile viewport zoom & pan
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [panOffset, setPlanarPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: 360,
    h: 360,
  });

  // Drawing & Touch State Machine
  const [drawStart, setDrawStart] = useState<Point2D | null>(null);
  const [drawStartCircle, setDrawStartCircle] = useState<CadCircleEntity | null>(null);
  const [arcStartPt, setArcStartPt] = useState<Point2D | null>(null);
  const [currentSnap, setCurrentSnap] = useState<SnapResult | null>(null);
  const [touchFingerScreen, setTouchFingerScreen] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clipboardToast, setClipboardToast] = useState<string | null>(null);

  const pressStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startScreenX: number;
    startScreenY: number;
    moved: boolean;
    startedNewDraw: boolean;
    startSnapPt: Point2D | null;
    panStartX: number;
    panStartY: number;
    gripDrag: {
      entityId: string;
      gripId: string;
      initialEntities: CadEntity[];
    } | null;
    moveDrag: {
      startWorld: Point2D;
      selectedIds: string[];
      initialEntities: CadEntity[];
    } | null;
    historyRecorded: boolean;
  }>({
    active: false,
    pointerId: null,
    startScreenX: 0,
    startScreenY: 0,
    moved: false,
    startedNewDraw: false,
    startSnapPt: null,
    panStartX: 0,
    panStartY: 0,
    gripDrag: null,
    moveDrag: null,
    historyRecorded: false,
  });

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startMidX: number;
    startMidY: number;
    startScale: number;
    startPanX: number;
    startPanY: number;
  }>({
    active: false,
    startDist: 100,
    startMidX: 0,
    startMidY: 0,
    startScale: 1,
    startPanX: 0,
    startPanY: 0,
  });

  useEffect(() => {
    setDrawStart(null);
    setDrawStartCircle(null);
    setArcStartPt(null);
    setTouchFingerScreen(null);
  }, [activeTool, view]);

  // Measure container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10) {
        setCanvasSize({ w: rect.width, h: rect.height });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute base fit scale so [0..120] x [0..120] fits comfortably in portrait canvas
  const baseTransform = useMemo(() => {
    const pad = compact ? 14 : 34;
    const availW = Math.max(40, canvasSize.w - pad * 2);
    const availH = Math.max(40, canvasSize.h - pad * 2);
    const baseZoom = Math.min(availW / 120, availH / 120);
    const effZoom = compact ? baseZoom : baseZoom * zoomScale;
    const gridW = 120 * effZoom;
    const gridH = 120 * effZoom;
    const originX = (canvasSize.w - gridW) / 2 + (compact ? 0 : panOffset.x);
    const topY = (canvasSize.h - gridH) / 2 + (compact ? 0 : panOffset.y);
    const bottomY = topY + gridH;
    return { effZoom, originX, topY, bottomY };
  }, [canvasSize.w, canvasSize.h, compact, zoomScale, panOffset.x, panOffset.y]);

  const worldToScreen = useCallback(
    (u: number, v: number) => {
      const { effZoom, originX, topY, bottomY } = baseTransform;
      return {
        x: originX + u * effZoom,
        y: view === 'top' ? topY + v * effZoom : bottomY - v * effZoom,
      };
    },
    [baseTransform, view]
  );

  const screenToWorld = useCallback(
    (sx: number, sy: number): Point2D => {
      const { effZoom, originX, topY, bottomY } = baseTransform;
      return {
        u: (sx - originX) / effZoom,
        v: view === 'top' ? (sy - topY) / effZoom : (bottomY - sy) / effZoom,
      };
    },
    [baseTransform, view]
  );

  const applyOrtho = useCallback(
    (start: Point2D | null, pt: Point2D): Point2D => {
      if (!start || !orthoEnabled) return pt;
      const du = pt.u - start.u;
      const dv = pt.v - start.v;
      if (Math.abs(du) >= Math.abs(dv)) {
        return { u: Number(pt.u.toFixed(1)), v: start.v };
      }
      return { u: start.u, v: Number(pt.v.toFixed(1)) };
    },
    [orthoEnabled]
  );

  const activeGrips = useMemo(() => {
    if (compact || activeTool !== 'select' || selectedIds.length === 0) return [];
    const selSet = new Set(selectedIds);
    const grips: { id: string; entityId: string; point: Point2D; kind: string }[] = [];
    for (const ent of entities) {
      if (ent.view === view && selSet.has(ent.id)) {
        grips.push(...getEntityGrips(ent));
      }
    }
    return grips;
  }, [compact, activeTool, selectedIds, entities, view]);

  const findHitGrip = useCallback(
    (worldPt: Point2D, tolWorld: number) => {
      let best: { grip: (typeof activeGrips)[0]; d: number } | null = null;
      for (const g of activeGrips) {
        const d = dist2D(worldPt, g.point);
        if (d <= tolWorld && (!best || d < best.d)) {
          best = { grip: g, d };
        }
      }
      return best ? best.grip : null;
    },
    [activeGrips]
  );

  const updateCursorAndSnap = useCallback(
    (
      rawScreenX: number,
      rawScreenY: number,
      useTouchOffset: boolean,
      anchorPt: Point2D | null,
      excludeIds?: Set<string>
    ): SnapResult => {
      const sampleY = useTouchOffset ? rawScreenY - TOUCH_OFFSET_PX : rawScreenY;
      const rawWorld = screenToWorld(rawScreenX, sampleY);
      const tolWorld = (snapTolerance + 4) / baseTransform.effZoom;
      const snap = computeOSnap(
        rawWorld,
        view,
        entities,
        enabledSnaps,
        gridStep,
        tolWorld,
        excludeIds,
        anchorPt || undefined
      );
      const finalPt = applyOrtho(anchorPt, snap.point);
      const finalSnap: SnapResult = { ...snap, point: finalPt };
      setCurrentSnap(finalSnap);
      onSnapStatusChange?.(finalSnap);

      if (view === 'front') {
        onUpdateSharedCursor({
          x: finalPt.u,
          y: sharedCursor.y,
          z: finalPt.v,
          activeView: 'front',
        });
      } else if (view === 'top') {
        onUpdateSharedCursor({
          x: finalPt.u,
          y: finalPt.v,
          z: sharedCursor.z,
          activeView: 'top',
        });
      } else {
        onUpdateSharedCursor({
          x: sharedCursor.x,
          y: finalPt.u,
          z: finalPt.v,
          activeView: 'left',
        });
      }
      return finalSnap;
    },
    [
      screenToWorld,
      snapTolerance,
      baseTransform.effZoom,
      view,
      entities,
      enabledSnaps,
      gridStep,
      applyOrtho,
      onSnapStatusChange,
      onUpdateSharedCursor,
      sharedCursor.x,
      sharedCursor.y,
      sharedCursor.z,
    ]
  );

  const commitGeometryFromPoints = useCallback(
    (startPt: Point2D, endPt: Point2D) => {
      const newId = `${view}-${activeTool}-${Date.now()}`;
      if (activeTool === 'line') {
        if (dist2D(startPt, endPt) > 0.5) {
          onChangeEntities([
            ...entities,
            {
              id: newId,
              view,
              type: 'line',
              lineType: activeLineType,
              p1: startPt,
              p2: endPt,
              source: 'user',
            },
          ]);
          return true;
        }
      } else if (activeTool === 'tangent') {
        let p1 = startPt;
        let p2 = endPt;
        const secondHovered = findHoveredEntity(
          endPt,
          view,
          entities,
          14 / baseTransform.effZoom
        );
        if (drawStartCircle) {
          p1 = computeCircleTangentPoint(
            endPt,
            drawStartCircle.center,
            drawStartCircle.radius,
            startPt
          );
        } else if (secondHovered && secondHovered.type === 'circle') {
          p2 = computeCircleTangentPoint(
            startPt,
            secondHovered.center,
            secondHovered.radius,
            endPt
          );
        }
        if (dist2D(p1, p2) > 0.5) {
          onChangeEntities([
            ...entities,
            {
              id: newId,
              view,
              type: 'line',
              lineType: activeLineType,
              p1,
              p2,
              source: 'user',
            },
          ]);
          return true;
        }
      } else if (activeTool === 'rect') {
        const x = Math.min(startPt.u, endPt.u);
        const y = Math.min(startPt.v, endPt.v);
        const width = Math.abs(endPt.u - startPt.u);
        const height = Math.abs(endPt.v - startPt.v);
        if (width >= 1 && height >= 1) {
          onChangeEntities([
            ...entities,
            {
              id: newId,
              view,
              type: 'rect',
              lineType: activeLineType,
              x: Number(x.toFixed(1)),
              y: Number(y.toFixed(1)),
              width: Number(width.toFixed(1)),
              height: Number(height.toFixed(1)),
              source: 'user',
            },
          ]);
          return true;
        }
      } else if (activeTool === 'circle') {
        const radius = Number(dist2D(startPt, endPt).toFixed(1));
        if (radius >= 1) {
          onChangeEntities([
            ...entities,
            {
              id: newId,
              view,
              type: 'circle',
              lineType: activeLineType,
              center: startPt,
              radius,
              source: 'user',
            },
          ]);
          return true;
        }
      } else if (activeTool === 'polygon') {
        const radius = dist2D(startPt, endPt);
        if (radius >= 1.5) {
          const sides = Math.max(3, Math.min(12, polygonSides));
          const baseAngle = Math.atan2(endPt.v - startPt.v, endPt.u - startPt.u);
          const pts: Point2D[] = [];
          for (let i = 0; i < sides; i++) {
            const ang = baseAngle + (i * Math.PI * 2) / sides;
            pts.push({
              u: Number((startPt.u + Math.cos(ang) * radius).toFixed(1)),
              v: Number((startPt.v + Math.sin(ang) * radius).toFixed(1)),
            });
          }
          onChangeEntities([
            ...entities,
            {
              id: newId,
              view,
              type: 'polygon',
              lineType: activeLineType,
              points: pts,
              closed: true,
              source: 'user',
            },
          ]);
          return true;
        }
      }
      return false;
    },
    [
      view,
      activeTool,
      onChangeEntities,
      entities,
      activeLineType,
      baseTransform.effZoom,
      drawStartCircle,
      polygonSides,
    ]
  );

  // Two-finger Touch Pinch-to-Zoom & Pan handlers
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (compact) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.max(
        12,
        Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
      );
      const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
      const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
      pinchRef.current = {
        active: true,
        startDist: dist,
        startMidX: midX,
        startMidY: midY,
        startScale: zoomScale,
        startPanX: panOffset.x,
        startPanY: panOffset.y,
      };
      pressStateRef.current.active = false;
      setTouchFingerScreen(null);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (compact) return;
    if (e.touches.length === 2 && pinchRef.current.active) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const curDist = Math.max(
        12,
        Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
      );
      const curMidX = (t0.clientX + t1.clientX) / 2 - rect.left;
      const curMidY = (t0.clientY + t1.clientY) / 2 - rect.top;
      const ratio = curDist / pinchRef.current.startDist;
      const nextScale = Math.max(
        0.5,
        Math.min(4.0, Number((pinchRef.current.startScale * ratio).toFixed(2)))
      );
      setZoomScale(nextScale);
      setPlanarPan({
        x: pinchRef.current.startPanX + (curMidX - pinchRef.current.startMidX),
        y: pinchRef.current.startPanY + (curMidY - pinchRef.current.startMidY),
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length < 2 && pinchRef.current.active) {
      pinchRef.current.active = false;
    }
  };

  // Single-finger / Pointer Gesture State Machine
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (compact) {
      onTapCompact?.();
      return;
    }
    if (pinchRef.current.active) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    // 1. Hand Pan Tool or Middle/Right button
    if (activeTool === 'pan' || e.button === 1 || e.button === 2) {
      pressStateRef.current = {
        active: true,
        pointerId: e.pointerId,
        startScreenX: sx,
        startScreenY: sy,
        moved: false,
        startedNewDraw: false,
        startSnapPt: null,
        panStartX: panOffset.x,
        panStartY: panOffset.y,
        gripDrag: null,
        moveDrag: null,
        historyRecorded: false,
      };
      return;
    }

    const directWorld = screenToWorld(sx, sy);
    const hitTolWorld = 14 / baseTransform.effZoom;

    // 2. Direct single-tap tools: Select, Erase, Trim, Extend, Offset
    if (activeTool === 'select') {
      const hitGrip = findHitGrip(directWorld, hitTolWorld);
      if (hitGrip) {
        pressStateRef.current = {
          active: true,
          pointerId: e.pointerId,
          startScreenX: sx,
          startScreenY: sy,
          moved: false,
          startedNewDraw: false,
          startSnapPt: hitGrip.point,
          panStartX: panOffset.x,
          panStartY: panOffset.y,
          gripDrag: {
            entityId: hitGrip.entityId,
            gripId: hitGrip.id,
            initialEntities: entities,
          },
          moveDrag: null,
          historyRecorded: false,
        };
        setTouchFingerScreen({ x: sx, y: sy });
        return;
      }

      const hovered = findHoveredEntity(directWorld, view, entities, hitTolWorld);
      if (hovered) {
        const nextSel = selectedIds.includes(hovered.id)
          ? selectedIds
          : [hovered.id];
        setSelectedIds(nextSel);
        pressStateRef.current = {
          active: true,
          pointerId: e.pointerId,
          startScreenX: sx,
          startScreenY: sy,
          moved: false,
          startedNewDraw: false,
          startSnapPt: directWorld,
          panStartX: panOffset.x,
          panStartY: panOffset.y,
          gripDrag: null,
          moveDrag: {
            startWorld: directWorld,
            selectedIds: nextSel,
            initialEntities: entities,
          },
          historyRecorded: false,
        };
        return;
      }

      setSelectedIds([]);
      return;
    }

    if (activeTool === 'erase') {
      const hovered = findHoveredEntity(directWorld, view, entities, hitTolWorld);
      if (hovered) {
        onChangeEntities(entities.filter((item) => item.id !== hovered.id));
        setSelectedIds((prev) => prev.filter((id) => id !== hovered.id));
      }
      return;
    }

    if (activeTool === 'trim') {
      onChangeEntities(trimEntityAtPoint(directWorld, view, entities));
      return;
    }

    if (activeTool === 'extend') {
      onChangeEntities(extendEntityAtPoint(directWorld, view, entities));
      return;
    }

    if (activeTool === 'offset') {
      onChangeEntities(
        offsetEntityAtPoint(directWorld, view, entities, offsetDistance)
      );
      return;
    }

    // 3. Drawing tools (line, rect, circle, polygon, arc, tangent):
    // Use 36px touch offset above finger so finger never blocks the snap point
    setTouchFingerScreen({ x: sx, y: sy });
    const snap = updateCursorAndSnap(sx, sy, true, drawStart);
    const pt = snap.point;

    if (!drawStart) {
      if (activeTool === 'tangent') {
        const hovered = findHoveredEntity(pt, view, entities, hitTolWorld);
        if (hovered && hovered.type === 'circle') {
          setDrawStartCircle(hovered);
        }
      }
      setDrawStart(pt);
      pressStateRef.current = {
        active: true,
        pointerId: e.pointerId,
        startScreenX: sx,
        startScreenY: sy,
        moved: false,
        startedNewDraw: true,
        startSnapPt: pt,
        panStartX: panOffset.x,
        panStartY: panOffset.y,
        gripDrag: null,
        moveDrag: null,
        historyRecorded: false,
      };
    } else {
      // Second tap in Two-Tap mode
      pressStateRef.current = {
        active: true,
        pointerId: e.pointerId,
        startScreenX: sx,
        startScreenY: sy,
        moved: false,
        startedNewDraw: false,
        startSnapPt: pt,
        panStartX: panOffset.x,
        panStartY: panOffset.y,
        gripDrag: null,
        moveDrag: null,
        historyRecorded: false,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (compact || pinchRef.current.active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const ps = pressStateRef.current;

    // Hand Pan mode
    if (ps.active && activeTool === 'pan') {
      const dx = sx - ps.startScreenX;
      const dy = sy - ps.startScreenY;
      if (Math.hypot(dx, dy) > 2) ps.moved = true;
      setPlanarPan({
        x: ps.panStartX + dx,
        y: ps.panStartY + dy,
      });
      return;
    }

    // Grip Dragging
    if (ps.active && ps.gripDrag) {
      setTouchFingerScreen({ x: sx, y: sy });
      const snap = updateCursorAndSnap(
        sx,
        sy,
        true,
        null,
        new Set([ps.gripDrag.entityId])
      );
      const replaceLast = ps.historyRecorded;
      ps.historyRecorded = true;
      onChangeEntities(
        ps.gripDrag.initialEntities.map((ent) =>
          ent.id === ps.gripDrag!.entityId
            ? applyGripDrag(ent, ps.gripDrag!.gripId, snap.point)
            : ent
        ),
        { replaceLast }
      );
      return;
    }

    // Entity Move Dragging
    if (ps.active && ps.moveDrag) {
      const curWorld = screenToWorld(sx, sy);
      const du = Number((curWorld.u - ps.moveDrag.startWorld.u).toFixed(1));
      const dv = Number((curWorld.v - ps.moveDrag.startWorld.v).toFixed(1));
      if (Math.hypot(du, dv) > 0.5) {
        const replaceLast = ps.historyRecorded;
        ps.historyRecorded = true;
        const moveSet = new Set(ps.moveDrag.selectedIds);
        onChangeEntities(
          ps.moveDrag.initialEntities.map((ent) =>
            ent.view === view && moveSet.has(ent.id)
              ? translateEntity(ent, du, dv)
              : ent
          ),
          { replaceLast }
        );
      }
      return;
    }

    // Drawing live preview
    if (ps.active) {
      const screenDist = Math.hypot(sx - ps.startScreenX, sy - ps.startScreenY);
      if (screenDist > 10) {
        ps.moved = true;
      }
      setTouchFingerScreen({ x: sx, y: sy });
      updateCursorAndSnap(sx, sy, true, drawStart);
    } else {
      // Hovering (e.g. stylus or mouse in mobile simulator)
      updateCursorAndSnap(sx, sy, false, drawStart);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (compact) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const ps = pressStateRef.current;
    if (!ps.active) {
      setTouchFingerScreen(null);
      return;
    }

    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const sx = rect ? e.clientX - rect.left : ps.startScreenX;
    const sy = rect ? e.clientY - rect.top : ps.startScreenY;

    if (activeTool === 'pan' || ps.gripDrag || ps.moveDrag) {
      pressStateRef.current.active = false;
      pressStateRef.current.gripDrag = null;
      pressStateRef.current.moveDrag = null;
      setTouchFingerScreen(null);
      return;
    }

    // Drawing tools completion logic:
    // Case A: User pressed, dragged (>10px), and released -> Press-Drag-Release mode!
    // Case B: User tapped once (startedNewDraw && !ps.moved) -> stay in Two-Tap mode waiting for 2nd tap!
    // Case C: User tapped 2nd time (!ps.startedNewDraw) -> commit from drawStart to current point!
    if (ps.startedNewDraw && !ps.moved) {
      // Keep drawStart active for 2nd tap; hide finger tether until next touch
      pressStateRef.current.active = false;
      setTouchFingerScreen(null);
      return;
    }

    if (drawStart) {
      const snap = updateCursorAndSnap(sx, sy, true, drawStart);
      const endPt = snap.point;

      if (activeTool === 'arc') {
        if (!arcStartPt) {
          if (dist2D(drawStart, endPt) >= 1.5) {
            setArcStartPt(endPt);
          }
        } else {
          const radius = Number(dist2D(drawStart, arcStartPt).toFixed(1));
          const startAngle = normalizeAngle(
            Math.atan2(arcStartPt.v - drawStart.v, arcStartPt.u - drawStart.u)
          );
          const endAngle = normalizeAngle(
            Math.atan2(endPt.v - drawStart.v, endPt.u - drawStart.u)
          );
          if (radius >= 1.5 && Math.abs(endAngle - startAngle) > 0.05) {
            onChangeEntities([
              ...entities,
              {
                id: `${view}-arc-${Date.now()}`,
                view,
                type: 'arc',
                lineType: activeLineType,
                center: drawStart,
                radius,
                startAngle,
                endAngle,
                source: 'user',
              },
            ]);
          }
          setDrawStart(null);
          setArcStartPt(null);
        }
      } else {
        const committed = commitGeometryFromPoints(drawStart, endPt);
        if (committed) {
          if (activeTool === 'line') {
            // In Two-Tap mode, chain lines continuously; in Drag mode, finish segment cleanly
            if (ps.startedNewDraw && ps.moved) {
              setDrawStart(null);
            } else {
              setDrawStart(endPt);
            }
          } else {
            setDrawStart(null);
            setDrawStartCircle(null);
          }
        }
      }
    }

    pressStateRef.current.active = false;
    setTouchFingerScreen(null);
  };

  // Copy / Paste / Batch LineType helpers for selected entities
  const handleCopySelected = () => {
    if (selectedIds.length === 0) return;
    const selSet = new Set(selectedIds);
    const picked = entities.filter((ent) => ent.view === view && selSet.has(ent.id));
    if (picked.length === 0) return;
    mobileClipboard = {
      entities: JSON.parse(JSON.stringify(picked)),
      sourceView: view,
      pasteCount: 0,
    };
    setClipboardToast(`已复制 ${picked.length} 项`);
    window.setTimeout(() => setClipboardToast(null), 1400);
  };

  const handlePasteClipboard = () => {
    if (!mobileClipboard.entities.length) return;
    mobileClipboard.pasteCount += 1;
    const stepOffset = Math.max(2, gridStep) * mobileClipboard.pasteCount;
    const now = Date.now();
    const pasted = mobileClipboard.entities.map((ent, idx) => ({
      ...translateEntity(ent, stepOffset, stepOffset),
      id: `${view}-${ent.type}-mpaste-${now}-${idx}`,
      view,
      source: 'user' as const,
    }));
    onChangeEntities([...entities, ...pasted]);
    onSwitchToSelect();
    setSelectedIds(pasted.map((e) => e.id));
    setClipboardToast(`已粘贴 ${pasted.length} 项`);
    window.setTimeout(() => setClipboardToast(null), 1400);
  };

  const handleBatchLineType = (lt: LineType) => {
    onChangeActiveLineType(lt);
    if (selectedIds.length === 0) return;
    const selSet = new Set(selectedIds);
    onChangeEntities(
      entities.map((ent) =>
        ent.view === view && selSet.has(ent.id)
          ? { ...ent, lineType: lt, source: 'user' }
          : ent
      )
    );
  };

  // Render 2D Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvasSize.w;
    const height = canvasSize.h;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = compact ? '#090D14' : '#0D131F';
    ctx.fillRect(0, 0, width, height);

    // Coordinate Grid
    const step = compact ? 20 : Math.max(2, gridStep);
    for (let u = 0; u <= 120; u += step) {
      const p0 = worldToScreen(u, 0);
      const p1 = worldToScreen(u, 120);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = u % 20 === 0 ? '#1E293B' : '#131C2B';
      ctx.lineWidth = u % 20 === 0 ? 1 : 0.6;
      ctx.stroke();

      if (!compact && u % 20 === 0 && u > 0) {
        ctx.fillStyle = '#475569';
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillText(`${u}`, p0.x - 6, view === 'top' ? p0.y - 4 : p0.y + 11);
      }
    }

    for (let v = 0; v <= 120; v += step) {
      const p0 = worldToScreen(0, v);
      const p1 = worldToScreen(120, v);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = v % 20 === 0 ? '#1E293B' : '#131C2B';
      ctx.lineWidth = v % 20 === 0 ? 1 : 0.6;
      ctx.stroke();

      if (!compact && v % 20 === 0 && v > 0) {
        ctx.fillStyle = '#475569';
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillText(`${v}`, p0.x - 16, p0.y + 3);
      }
    }

    // Axes
    const orig = worldToScreen(0, 0);
    const uEnd = worldToScreen(124, 0);
    const vEnd = worldToScreen(0, 124);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = compact ? 1 : 1.3;
    ctx.beginPath();
    ctx.moveTo(orig.x, orig.y);
    ctx.lineTo(uEnd.x, uEnd.y);
    ctx.moveTo(orig.x, orig.y);
    ctx.lineTo(vEnd.x, vEnd.y);
    ctx.stroke();

    if (!compact) {
      ctx.fillStyle = '#64748B';
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.fillText(axisLabels.u, uEnd.x + 3, uEnd.y + 3);
      ctx.fillText(
        axisLabels.v,
        vEnd.x - 4,
        view === 'top' ? vEnd.y + 11 : vEnd.y - 5
      );
    }

    // Cross-View Dynamic Alignment Rays (长对正 X / 高平齐 Z / 宽相等 Y)
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = compact ? 1.2 : 1.1;
    const alignU = view === 'front' || view === 'top' ? sharedCursor.x : sharedCursor.y;
    const alignV = view === 'front' || view === 'left' ? sharedCursor.z : sharedCursor.y;

    if (alignU !== null && alignU >= 0 && alignU <= 125) {
      const pTop = worldToScreen(alignU, 0);
      const isYAxis = view === 'left';
      ctx.strokeStyle = isYAxis
        ? 'rgba(16, 185, 129, 0.85)'
        : 'rgba(56, 189, 248, 0.85)';
      ctx.beginPath();
      ctx.moveTo(pTop.x, 0);
      ctx.lineTo(pTop.x, height);
      ctx.stroke();

      if (compact) {
        ctx.fillStyle = isYAxis ? '#10B981' : '#38BDF8';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.fillText(
          `${isYAxis ? '宽Y' : '长X'}=${alignU.toFixed(0)}`,
          Math.min(width - 42, Math.max(4, pTop.x + 3)),
          height - 5
        );
      }
    }

    if (alignV !== null && alignV >= 0 && alignV <= 125) {
      const pLeft = worldToScreen(0, alignV);
      const isYAxis = view === 'top';
      ctx.strokeStyle = isYAxis
        ? 'rgba(16, 185, 129, 0.85)'
        : 'rgba(245, 158, 11, 0.85)';
      ctx.beginPath();
      ctx.moveTo(0, pLeft.y);
      ctx.lineTo(width, pLeft.y);
      ctx.stroke();

      if (compact) {
        ctx.fillStyle = isYAxis ? '#10B981' : '#F59E0B';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.fillText(
          `${isYAxis ? '宽Y' : '高Z'}=${alignV.toFixed(0)}`,
          width - 44,
          Math.max(10, pLeft.y - 3)
        );
      }
    }
    ctx.restore();

    // Entities in this view
    const selSet = new Set(selectedIds);
    const viewEntities = entities.filter((e) => e.view === view);
    for (const ent of viewEntities) {
      const isSelected = !compact && selSet.has(ent.id);
      ctx.save();
      if (isSelected) {
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
      } else if (ent.lineType === 'thick_solid') {
        ctx.strokeStyle = ent.source === 'derived' ? '#E0F2FE' : '#F8FAFC';
        ctx.lineWidth = compact ? 1.8 : 2.4;
        ctx.setLineDash([]);
      } else if (ent.lineType === 'thin_dashed') {
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = compact ? 1.2 : 1.5;
        ctx.setLineDash([6, 3]);
      } else if (ent.lineType === 'center_dot_dash') {
        ctx.strokeStyle = '#06B6D4';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([10, 3, 2, 3]);
      } else {
        ctx.strokeStyle = '#10B981';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
      }

      if (ent.type === 'circle') {
        const c = worldToScreen(ent.center.u, ent.center.v);
        ctx.beginPath();
        ctx.arc(c.x, c.y, ent.radius * baseTransform.effZoom, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const segs = expandEntityToSegments(ent, 40);
        ctx.beginPath();
        let lastX = NaN;
        let lastY = NaN;
        for (const s of segs) {
          const p1 = worldToScreen(s.p1.u, s.p1.v);
          const p2 = worldToScreen(s.p2.u, s.p2.v);
          if (Number.isNaN(lastX) || Math.hypot(p1.x - lastX, p1.y - lastY) > 0.5) {
            ctx.moveTo(p1.x, p1.y);
          }
          ctx.lineTo(p2.x, p2.y);
          lastX = p2.x;
          lastY = p2.y;
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Grips on selected entities
    if (!compact && activeTool === 'select' && activeGrips.length > 0) {
      ctx.save();
      for (const g of activeGrips) {
        const sp = worldToScreen(g.point.u, g.point.v);
        const sz = 5.5;
        ctx.fillStyle = g.kind === 'center' ? '#10B981' : '#06B6D4';
        ctx.strokeStyle = '#0B0F17';
        ctx.lineWidth = 1.4;
        ctx.fillRect(sp.x - sz, sp.y - sz, sz * 2, sz * 2);
        ctx.strokeRect(sp.x - sz, sp.y - sz, sz * 2, sz * 2);
      }
      ctx.restore();
    }

    // Diagnostic Error Highlights
    if (!compact) {
      for (const issue of diagnostics) {
        if (!issue.highlightCoords) continue;
        for (const hc of issue.highlightCoords) {
          if (hc.view !== view) continue;
          const p1 = worldToScreen(hc.p1.u, hc.p1.v);
          const p2 = hc.p2 ? worldToScreen(hc.p2.u, hc.p2.v) : p1;
          ctx.save();
          ctx.strokeStyle = '#EF4444';
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 3]);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Active Drawing Preview
    if (!compact && drawStart && currentSnap) {
      const p1 = worldToScreen(drawStart.u, drawStart.v);
      const p2 = worldToScreen(currentSnap.point.u, currentSnap.point.v);
      ctx.save();
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);

      if (activeTool === 'line' || activeTool === 'tangent') {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (activeTool === 'rect') {
        ctx.strokeRect(
          Math.min(p1.x, p2.x),
          Math.min(p1.y, p2.y),
          Math.abs(p2.x - p1.x),
          Math.abs(p2.y - p1.y)
        );
      } else if (activeTool === 'circle') {
        const r = dist2D(drawStart, currentSnap.point) * baseTransform.effZoom;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (activeTool === 'polygon') {
        const radius = dist2D(drawStart, currentSnap.point);
        const sides = Math.max(3, Math.min(12, polygonSides));
        const baseAngle = Math.atan2(
          currentSnap.point.v - drawStart.v,
          currentSnap.point.u - drawStart.u
        );
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const ang = baseAngle + ((i % sides) * Math.PI * 2) / sides;
          const sp = worldToScreen(
            drawStart.u + Math.cos(ang) * radius,
            drawStart.v + Math.sin(ang) * radius
          );
          if (i === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        }
        ctx.stroke();
      } else if (activeTool === 'arc') {
        if (!arcStartPt) {
          const r = dist2D(drawStart, currentSnap.point) * baseTransform.effZoom;
          ctx.beginPath();
          ctx.arc(p1.x, p1.y, r, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const radius = dist2D(drawStart, arcStartPt);
          const startAngle = normalizeAngle(
            Math.atan2(arcStartPt.v - drawStart.v, arcStartPt.u - drawStart.u)
          );
          const endAngle = normalizeAngle(
            Math.atan2(
              currentSnap.point.v - drawStart.v,
              currentSnap.point.u - drawStart.u
            )
          );
          const previewSegs = expandEntityToSegments(
            {
              id: 'm-preview-arc',
              view,
              type: 'arc',
              lineType: activeLineType,
              center: drawStart,
              radius,
              startAngle,
              endAngle,
            },
            32
          );
          ctx.beginPath();
          for (const s of previewSegs) {
            const sp1 = worldToScreen(s.p1.u, s.p1.v);
            const sp2 = worldToScreen(s.p2.u, s.p2.v);
            ctx.moveTo(sp1.x, sp1.y);
            ctx.lineTo(sp2.x, sp2.y);
          }
          ctx.stroke();
        }
      }

      // Highlight drawStart anchor point
      ctx.setLineDash([]);
      ctx.fillStyle = '#38BDF8';
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 36px Touch Offset Crosshair & Finger Tether Indicator
    if (!compact && currentSnap) {
      const sp = worldToScreen(currentSnap.point.u, currentSnap.point.v);
      ctx.save();

      if (touchFingerScreen) {
        // Finger contact halo
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(touchFingerScreen.x, touchFingerScreen.y, 14, 0, Math.PI * 2);
        ctx.stroke();

        // Tether from finger to 36px offset crosshair
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.75)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(touchFingerScreen.x, touchFingerScreen.y);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Precision offset crosshair
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sp.x - 12, sp.y);
        ctx.lineTo(sp.x + 12, sp.y);
        ctx.moveTo(sp.x, sp.y - 12);
        ctx.lineTo(sp.x, sp.y + 12);
        ctx.stroke();

        // Floating Coordinate & Snap Magnifier Pill above crosshair
        const snapLabel = `${currentSnap.label} (${currentSnap.point.u.toFixed(0)}, ${currentSnap.point.v.toFixed(0)})`;
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        const tw = ctx.measureText(snapLabel).width + 12;
        const bx = Math.max(6, Math.min(width - tw - 6, sp.x - tw / 2));
        const by = Math.max(24, sp.y - 22);
        ctx.fillStyle = 'rgba(11, 15, 23, 0.94)';
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 1.2;
        ctx.fillRect(bx, by - 14, tw, 18);
        ctx.strokeRect(bx, by - 14, tw, 18);
        ctx.fillStyle = '#E0F2FE';
        ctx.fillText(snapLabel, bx + 6, by - 2);
      } else {
        // Standard snap marker
        ctx.strokeStyle = '#22D3EE';
        ctx.lineWidth = 1.8;
        ctx.strokeRect(sp.x - 4, sp.y - 4, 8, 8);
      }
      ctx.restore();
    }

    ctx.restore();
  }, [
    canvasSize,
    compact,
    gridStep,
    worldToScreen,
    view,
    axisLabels,
    sharedCursor,
    entities,
    selectedIds,
    baseTransform.effZoom,
    activeTool,
    activeGrips,
    diagnostics,
    drawStart,
    currentSnap,
    polygonSides,
    arcStartPt,
    activeLineType,
    touchFingerScreen,
  ]);

  const isViewTransformed =
    Math.abs(zoomScale - 1) > 0.03 ||
    Math.hypot(panOffset.x, panOffset.y) > 2;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none touch-none bg-[#0D131F]"
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="w-full h-full block touch-none"
      />

      {/* Compact Thumbnail Overlay */}
      {compact && (
        <div className="absolute top-1.5 left-2 pointer-events-none flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-[#111827]/90 border border-[#263244] text-[10px] font-semibold text-[#E2E8F0]">
            {title} ({axisLabels.u}-{axisLabels.v})
          </span>
        </div>
      )}

      {/* Main Active Viewport Overlays */}
      {!compact && (
        <>
          {/* Top-Right Reset View & Finish/Cancel Drawing Micro-Buttons */}
          <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1.5">
            {drawStart !== null && (
              <>
                <button
                  onClick={() => {
                    setDrawStart(null);
                    setDrawStartCircle(null);
                    setArcStartPt(null);
                  }}
                  className="min-h-[36px] px-3 py-1 rounded-lg bg-[#059669] active:bg-[#047857] text-xs font-semibold text-white shadow-lg flex items-center gap-1"
                >
                  <span>✓ 完成</span>
                </button>
                <button
                  onClick={() => {
                    setDrawStart(null);
                    setDrawStartCircle(null);
                    setArcStartPt(null);
                  }}
                  className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#7F1D1D]/90 border border-[#EF4444] text-xs font-medium text-[#FEE2E2] shadow-lg"
                >
                  ✕ 取消
                </button>
              </>
            )}

            {isViewTransformed && (
              <button
                onClick={() => {
                  setZoomScale(1);
                  setPlanarPan({ x: 0, y: 0 });
                }}
                className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#111827]/90 border border-[#38BDF8]/50 text-[11px] font-mono text-[#E0F2FE] shadow-lg"
              >
                {Math.round(zoomScale * 100)}% 复位
              </button>
            )}
          </div>

          {clipboardToast && (
            <div className="absolute top-12 left-2.5 z-20 px-2.5 py-1 rounded-lg bg-[#064E3B]/95 border border-[#10B981] text-[11px] font-mono text-[#A7F3D0]">
              {clipboardToast}
            </div>
          )}

          {/* Selected Entities Touch Action Bar */}
          {(selectedIds.length > 0 || mobileClipboard.entities.length > 0) && (
            <div className="absolute bottom-2.5 left-2.5 right-2.5 z-20 flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#111827]/95 border border-[#38BDF8]/50 backdrop-blur-md shadow-xl overflow-x-auto">
              {selectedIds.length > 0 ? (
                <>
                  <button
                    onClick={handleCopySelected}
                    className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#16273B] border border-[#38BDF8]/40 text-xs font-medium text-[#E0F2FE] whitespace-nowrap"
                  >
                    复制 ({selectedIds.length})
                  </button>
                  {mobileClipboard.entities.length > 0 && (
                    <button
                      onClick={handlePasteClipboard}
                      className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#059669] text-xs font-medium text-white whitespace-nowrap"
                    >
                      粘贴
                    </button>
                  )}
                  <div className="flex items-center gap-1">
                    {[
                      { lt: 'thick_solid' as LineType, label: '实线' },
                      { lt: 'thin_dashed' as LineType, label: '虚线' },
                      { lt: 'center_dot_dash' as LineType, label: '点画' },
                    ].map((b) => (
                      <button
                        key={b.lt}
                        onClick={() => handleBatchLineType(b.lt)}
                        className="min-h-[36px] px-2 py-1 rounded-lg bg-[#0B0F17] border border-[#263244] text-[11px] text-[#CBD5E1] whitespace-nowrap"
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      const delSet = new Set(selectedIds);
                      onChangeEntities(
                        entities.filter((ent) => !delSet.has(ent.id))
                      );
                      setSelectedIds([]);
                    }}
                    className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#7F1D1D]/80 border border-[#EF4444] text-xs font-medium text-[#FEE2E2] whitespace-nowrap"
                  >
                    删除
                  </button>
                </>
              ) : (
                <button
                  onClick={handlePasteClipboard}
                  className="min-h-[36px] px-3 py-1 rounded-lg bg-[#059669] text-xs font-medium text-white whitespace-nowrap"
                >
                  粘贴已复制图元 ({mobileClipboard.entities.length})
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
