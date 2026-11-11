import React, { Component, ErrorInfo, ReactNode, useEffect, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  Clock,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MOUSE,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AlertTriangle, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { Primitive3D } from '../types/cad';
import {
  buildSinglePrimitiveGeometry,
  buildWatertightManifoldGeometry,
  extractSharpFeatureEdges,
} from '../kernel';

export interface Viewport3DProps {
  primitives: Primitive3D[];
  hoveredFeatureId: string | null;
  xRayMode: boolean;
  onToggleXRay: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  materialPreset?: 'steel' | 'aluminum' | 'brass' | 'ceramic';
  labels: {
    front: string;
    left: string;
    top: string;
    iso: string;
    xray: string;
    fullscreen: string;
    exitFullscreen: string;
  };
}

const MATERIAL_PRESETS: Record<
  string,
  {
    color: number;
    metalness: number;
    roughness: number;
    clearcoat: number;
    edgeColor: number;
  }
> = {
  steel: {
    color: 0x64748b,
    metalness: 0.55,
    roughness: 0.28,
    clearcoat: 0.25,
    edgeColor: 0xe2e8f0,
  },
  aluminum: {
    color: 0xb8c4d8,
    metalness: 0.72,
    roughness: 0.22,
    clearcoat: 0.3,
    edgeColor: 0xf8fafc,
  },
  brass: {
    color: 0xd2a846,
    metalness: 0.78,
    roughness: 0.24,
    clearcoat: 0.2,
    edgeColor: 0xfef08a,
  },
  ceramic: {
    color: 0xcddbe4,
    metalness: 0.08,
    roughness: 0.16,
    clearcoat: 0.65,
    edgeColor: 0x94adc2,
  },
};

function isValidPrimitive(p: Primitive3D | null | undefined): p is Primitive3D {
  if (!p) return false;
  if (
    !Number.isFinite(p.xMin) ||
    !Number.isFinite(p.xMax) ||
    !Number.isFinite(p.yMin) ||
    !Number.isFinite(p.yMax) ||
    !Number.isFinite(p.zMin) ||
    !Number.isFinite(p.zMax)
  ) {
    return false;
  }
  if (p.shape !== 'plane_sheet') {
    if (
      p.xMax - p.xMin <= 0.05 ||
      p.yMax - p.yMin <= 0.05 ||
      p.zMax - p.zMin <= 0.05
    ) {
      return false;
    }
  }
  return true;
}

const Viewport3DCore: React.FC<Viewport3DProps> = ({
  primitives,
  hoveredFeatureId,
  xRayMode,
  onToggleXRay,
  isFullscreen,
  onToggleFullscreen,
  materialPreset = 'steel',
  labels,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [activePreset, setActivePreset] = useState<'front' | 'left' | 'top' | 'iso'>('iso');
  const [webglUnavailable, setWebglUnavailable] = useState<string | null>(null);

  const stateRef = useRef({
    primitives,
    hoveredFeatureId,
    xRayMode,
    materialPreset,
    cameraTransitioning: false,
    desiredCamPos: new Vector3(95, 78, 105),
    desiredTarget: new Vector3(0, 0, 0),
  });

  const requestRenderRef = useRef<() => void>(() => {});
  const rebuildModelRef = useRef<() => void>(() => {});
  const rebuildHighlightRef = useRef<() => void>(() => {});

  useEffect(() => {
    stateRef.current.hoveredFeatureId = hoveredFeatureId;
    stateRef.current.xRayMode = xRayMode;
    stateRef.current.materialPreset = materialPreset;
    rebuildHighlightRef.current();
    requestRenderRef.current();
  }, [hoveredFeatureId, xRayMode, materialPreset]);

  useEffect(() => {
    stateRef.current.primitives = primitives;
    let rafId = 0;
    const timerId = window.setTimeout(() => {
      rafId = requestAnimationFrame(() => {
        rebuildModelRef.current();
        rebuildHighlightRef.current();
        requestRenderRef.current();
      });
    }, 16);
    return () => {
      window.clearTimeout(timerId);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [primitives]);

  const triggerCameraView = (preset: 'front' | 'left' | 'top' | 'iso') => {
    setActivePreset(preset);
    stateRef.current.cameraTransitioning = true;
    if (preset === 'iso') stateRef.current.desiredCamPos.set(95, 78, 105);
    else if (preset === 'front') stateRef.current.desiredCamPos.set(0, 5, 145);
    else if (preset === 'top') stateRef.current.desiredCamPos.set(0, 150, 0.01);
    else if (preset === 'left') stateRef.current.desiredCamPos.set(-145, 5, 0);
    stateRef.current.desiredTarget.set(0, 0, 0);
    requestRenderRef.current();
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return true;
      }
    })();

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      });
    } catch (err) {
      setWebglUnavailable(
        err instanceof Error ? err.message : '当前浏览器环境未开启 WebGL 3D 硬件/软件上下文'
      );
      return;
    }
    setWebglUnavailable(null);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = PCFSoftShadowMap;

    const width = container.clientWidth || 500;
    const height = container.clientHeight || 380;
    renderer.setSize(width, height);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = new Color(0x0d131f);

    let envTarget: ReturnType<PMREMGenerator['fromScene']> | null = null;
    try {
      const pmremGenerator = new PMREMGenerator(renderer);
      envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
      scene.environment = envTarget.texture;
      pmremGenerator.dispose();
    } catch {
      // Fallback to direct hemisphere + key + rim lights if PMREM fails
    }

    const camera = new PerspectiveCamera(36, width / height, 1, 1000);
    camera.position.set(95, 78, 105);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.08;
    controls.maxDistance = 320;
    controls.minDistance = 35;
    controls.mouseButtons = {
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.ROTATE,
      RIGHT: MOUSE.PAN,
    };

    const hemiLight = new HemisphereLight(0xdbeafe, 0x1e293b, 0.85);
    scene.add(hemiLight);

    const keyLight = new DirectionalLight(0xfff7ed, 1.65);
    keyLight.position.set(80, 120, 90);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -70;
    keyLight.shadow.camera.right = 70;
    keyLight.shadow.camera.top = 70;
    keyLight.shadow.camera.bottom = -70;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new DirectionalLight(0x38bdf8, 0.75);
    rimLight.position.set(-90, 50, -80);
    scene.add(rimLight);

    const shadowPlaneGeom = new PlaneGeometry(140, 140);
    const shadowPlaneMat = new MeshBasicMaterial({
      color: 0x070b12,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    const shadowPlane = new Mesh(shadowPlaneGeom, shadowPlaneMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -32;
    scene.add(shadowPlane);

    const modelGroup = new Group();
    const highlightGroup = new Group();
    scene.add(modelGroup);
    scene.add(highlightGroup);

    const mainSolidMaterial = new MeshPhysicalMaterial({
      color: MATERIAL_PRESETS.steel.color,
      metalness: MATERIAL_PRESETS.steel.metalness,
      roughness: MATERIAL_PRESETS.steel.roughness,
      clearcoat: MATERIAL_PRESETS.steel.clearcoat,
      clearcoatRoughness: 0.2,
      flatShading: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      side: DoubleSide,
    });

    const mainEdgesMaterial = new LineBasicMaterial({
      color: MATERIAL_PRESETS.steel.edgeColor,
      transparent: true,
      opacity: 0.78,
    });

    const highlightMeshMat = new MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: DoubleSide,
    });

    const highlightEdgeMat = new LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.95,
    });

    const clearGroup = (grp: Group) => {
      while (grp.children.length > 0) {
        const ch = grp.children[0] as Mesh | LineSegments;
        if (ch.geometry) ch.geometry.dispose();
        grp.remove(ch);
      }
    };

    const buildManifoldModel = () => {
      clearGroup(modelGroup);
      const validPrims = (stateRef.current.primitives || []).filter(isValidPrimitive);
      if (validPrims.length === 0) return;

      try {
        const manifoldGeom = buildWatertightManifoldGeometry(validPrims, 'threejs');
        const posAttr = manifoldGeom.getAttribute('position');
        if (posAttr && posAttr.count >= 3) {
          const solidMesh = new Mesh(manifoldGeom, mainSolidMaterial);
          solidMesh.castShadow = !isSoftwareGl;
          solidMesh.receiveShadow = !isSoftwareGl;
          solidMesh.renderOrder = 1;
          modelGroup.add(solidMesh);

          const creaseGeom = extractSharpFeatureEdges(manifoldGeom, 32);
          const creaseLines = new LineSegments(creaseGeom, mainEdgesMaterial);
          creaseLines.renderOrder = 2;
          modelGroup.add(creaseLines);
        } else {
          manifoldGeom.dispose();
          for (const prim of validPrims.filter((p) => p.operation !== 'subtract')) {
            const fbGeom = buildSinglePrimitiveGeometry(prim, 'threejs');
            modelGroup.add(new Mesh(fbGeom, mainSolidMaterial));
          }
        }
      } catch {
        for (const prim of validPrims.filter((p) => p.operation !== 'subtract')) {
          try {
            const fbGeom = buildSinglePrimitiveGeometry(prim, 'threejs');
            modelGroup.add(new Mesh(fbGeom, mainSolidMaterial));
          } catch {
            // Isolate individual primitive error
          }
        }
      }
    };

    const buildHoverHighlight = () => {
      clearGroup(highlightGroup);
      const hovId = stateRef.current.hoveredFeatureId;
      if (!hovId) return;
      const validPrims = (stateRef.current.primitives || []).filter(
        (p) => isValidPrimitive(p) && p.featureId === hovId
      );
      for (const prim of validPrims) {
        try {
          const g = buildSinglePrimitiveGeometry(prim, 'threejs');
          const m = new Mesh(g, highlightMeshMat);
          m.renderOrder = 3;
          highlightGroup.add(m);
          const eg = extractSharpFeatureEdges(g, 30);
          const el = new LineSegments(eg, highlightEdgeMat);
          el.renderOrder = 4;
          highlightGroup.add(el);
        } catch {
          // Ignore highlight failure
        }
      }
    };

    rebuildModelRef.current = buildManifoldModel;
    rebuildHighlightRef.current = buildHoverHighlight;
    buildManifoldModel();
    buildHoverHighlight();

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;
    const clock = new Clock();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const poll = () => {
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
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
        const dt = Math.min(clock.getDelta(), 0.1) || 0.016;
        const st = stateRef.current;
        const isXRay = st.xRayMode;
        const matCfg = MATERIAL_PRESETS[st.materialPreset] || MATERIAL_PRESETS.steel;

        mainSolidMaterial.color.setHex(matCfg.color);
        mainSolidMaterial.metalness = matCfg.metalness;
        mainSolidMaterial.roughness = matCfg.roughness;
        mainSolidMaterial.clearcoat = matCfg.clearcoat;
        mainSolidMaterial.transparent = isXRay;
        mainSolidMaterial.opacity = isXRay ? 0.42 : 1;
        mainSolidMaterial.depthWrite = !isXRay;
        mainSolidMaterial.needsUpdate = true;

        mainEdgesMaterial.color.setHex(matCfg.edgeColor);
        mainEdgesMaterial.opacity = isXRay ? 0.92 : 0.78;

        let stillMoving = false;
        if (st.cameraTransitioning) {
          const k = 1 - Math.exp(-8 * dt);
          camera.position.lerp(st.desiredCamPos, k);
          controls.target.lerp(st.desiredTarget, k);
          if (camera.position.distanceTo(st.desiredCamPos) < 0.4) {
            camera.position.copy(st.desiredCamPos);
            st.cameraTransitioning = false;
          } else {
            stillMoving = true;
          }
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
    controls.addEventListener('start', onControlStart);
    controls.addEventListener('change', onControlChange);

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
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('change', onControlChange);
      controls.dispose();
      clearGroup(modelGroup);
      clearGroup(highlightGroup);
      shadowPlaneGeom.dispose();
      shadowPlaneMat.dispose();
      mainSolidMaterial.dispose();
      mainEdgesMaterial.dispose();
      highlightMeshMat.dispose();
      highlightEdgeMat.dispose();
      envTarget?.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      className="relative w-full h-full bg-[#0D131F] overflow-hidden select-none"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
    >
      <div ref={mountRef} className="w-full h-full" />
      {webglUnavailable && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-[#0D131F] gap-2">
          <AlertTriangle className="w-5 h-5 text-[#F59E0B]" />
          <div className="text-xs font-medium text-white">3D WebGL 视窗离线保护模式</div>
          <div className="text-[11px] text-[#94A3B8] max-w-xs">{webglUnavailable}</div>
        </div>
      )}

      {/* Top-Left Camera & X-Ray Controls (Solid/Alpha surface without backdrop-filter over WebGL) */}
      <div className="absolute top-2.5 left-3 z-10 flex items-center bg-[#111827]/95 border border-[#263244] rounded p-0.5 gap-0.5">
        {(
          [
            { id: 'front', label: labels.front },
            { id: 'left', label: labels.left },
            { id: 'top', label: labels.top },
            { id: 'iso', label: labels.iso },
          ] as const
        ).map((btn) => (
          <button
            key={btn.id}
            type="button"
            onClick={() => triggerCameraView(btn.id)}
            className={`px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activePreset === btn.id
                ? 'bg-[#0284C7] text-white'
                : 'text-[#94A3B8] hover:text-white hover:bg-[#1E293B]'
            }`}
          >
            {btn.label}
          </button>
        ))}
        <div className="w-[1px] h-3.5 bg-[#263244] mx-0.5" />
        <button
          type="button"
          onClick={onToggleXRay}
          className={`px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
            xRayMode
              ? 'bg-[#D97706] text-white'
              : 'text-[#94A3B8] hover:text-white hover:bg-[#1E293B]'
          }`}
        >
          {labels.xray}
        </button>
      </div>

      {/* Top-Right Fullscreen Toggle */}
      <div className="absolute top-2.5 right-3 z-10">
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="p-1.5 rounded bg-[#111827]/95 border border-[#263244] text-[#94A3B8] hover:text-white hover:bg-[#1E293B] transition-colors"
          title={isFullscreen ? labels.exitFullscreen : labels.fullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="w-3.5 h-3.5" />
          ) : (
            <Maximize2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
};

interface ViewportErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class Viewport3DErrorBoundary extends Component<
  { children: ReactNode },
  ViewportErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ViewportErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || '3D WebGL 渲染器初始化异常',
    };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Error is safely contained within 3D viewport boundary
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full bg-[#0D131F] flex flex-col items-center justify-center p-4 text-center space-y-2.5 select-none">
          <AlertTriangle className="w-6 h-6 text-[#F59E0B]" />
          <div className="text-xs font-semibold text-white">
            3D 视窗安全隔离模式
          </div>
          <p className="text-[11px] text-[#94A3B8] max-w-xs">
            {this.state.errorMessage}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, errorMessage: '' })}
            className="px-3 py-1 rounded bg-[#0284C7] hover:bg-[#0369A1] text-xs font-medium text-white inline-flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            <span>重载 3D 视窗</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const Viewport3D: React.FC<Viewport3DProps> = (props) => (
  <Viewport3DErrorBoundary>
    <Viewport3DCore {...props} />
  </Viewport3DErrorBoundary>
);
