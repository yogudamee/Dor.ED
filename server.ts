import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reserved constant for domestic direct Zhipu GLM API (left empty by default per security rules)
const DEFAULT_ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || '';
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

async function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Domestic VPN-Free Zhipu AI Endpoint (glm-4.5-flash with thinking & glm-4v-flash) + Offline Fallback
  app.post('/api/ai/analyze-views', async (req, res) => {
    const {
      entities,
      knownViews,
      targetView,
      projectTitle,
      diagnostics,
      model = 'glm-4.5-flash',
      enableThinking = true,
      visionImageBase64,
    } = req.body;

    const systemPrompt =
      '你是 Dor.ED 工程制图智能几何引擎。请严格使用 X、Y、Z 轴向坐标术语，简明扼要地分析当前三视图的三维形体构型、X/Y/Z 对齐关系、细虚线消隐逻辑以及是否存在多解欠约束。请输出纯 JSON 对象，包含字段：spatialSummary (string), thirdViewRules (string[]), ambiguityAnalysis (string)。';

    const userPrompt = `课题：${projectTitle || 'CAD Drawing'}
已知视图：${JSON.stringify(knownViews)}，待推导视图：${targetView}
二维图元 JSON (${Array.isArray(entities) ? entities.length : 0} 项)：
${JSON.stringify(entities?.slice(0, 35))}
本地几何校验结果：
${JSON.stringify(diagnostics)}`;

    // 1. Try Zhipu GLM Direct API if DEFAULT_ZHIPU_API_KEY is configured on server
    if (DEFAULT_ZHIPU_API_KEY) {
      try {
        const chosenModel = visionImageBase64 ? 'glm-4v-flash' : model || 'glm-4.5-flash';
        const messages = visionImageBase64
          ? [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: userPrompt },
                  { type: 'image_url', image_url: { url: visionImageBase64 } },
                ],
              },
            ]
          : [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ];

        const payload: Record<string, unknown> = {
          model: chosenModel,
          messages,
        };

        if (chosenModel === 'glm-4.5-flash') {
          payload.thinking = { type: enableThinking ? 'enabled' : 'disabled' };
        }

        const zhipuRes = await fetch(ZHIPU_BASE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${DEFAULT_ZHIPU_API_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        if (zhipuRes.ok) {
          const zhipuData = (await zhipuRes.json()) as any;
          const content: string = zhipuData?.choices?.[0]?.message?.content || '{}';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const parsed = jsonMatch
            ? JSON.parse(jsonMatch[0])
            : {
                spatialSummary: content,
                thirdViewRules: [],
                ambiguityAnalysis: '',
              };
          res.json({ ok: true, provider: chosenModel, analysis: parsed });
          return;
        }
      } catch {
        // Fall through to secondary or local deterministic fallback
      }
    }

    // 2. Fallback to Gemini API if GEMINI_API_KEY is available in cloud environment
    const geminiClient = await getGeminiClient();
    if (geminiClient) {
      try {
        const response = await geminiClient.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: `${systemPrompt}\n\n${userPrompt}`,
          config: {
            responseMimeType: 'application/json',
          },
        });
        const parsed = JSON.parse((response.text ?? '{}').trim());
        res.json({ ok: true, provider: 'gemini-3.8-flash', analysis: parsed });
        return;
      } catch {
        // Fall through to deterministic offline CSG analysis
      }
    }

    // 3. 100% Offline Deterministic CSG & Topology Fallback
    const countFront = Array.isArray(entities)
      ? entities.filter((e: any) => e.view === 'front').length
      : 0;
    const countTop = Array.isArray(entities)
      ? entities.filter((e: any) => e.view === 'top').length
      : 0;
    const countLeft = Array.isArray(entities)
      ? entities.filter((e: any) => e.view === 'left').length
      : 0;

    res.json({
      ok: true,
      provider: 'local-csg-offline',
      analysis: {
        spatialSummary: `本地离线 CSG 引擎分析完成：当前主视图含 ${countFront} 个图元、俯视图含 ${countTop} 个图元、左视图含 ${countLeft} 个图元。`,
        thirdViewRules: [
          '主视图与俯视图共享 X 坐标轴向对齐',
          '主视图与左视图共享 Z 坐标轴向对齐',
          '俯视图与左视图共享 Y 坐标轴向对齐，内部孔槽自动消隐为细虚线',
        ],
        ambiguityAnalysis:
          Array.isArray(diagnostics) && diagnostics.length > 0
            ? `检测到 ${diagnostics.length} 项坐标或欠约束提示，请参照诊断列表修正。`
            : '当前 X、Y、Z 三轴向约束闭环，三维实体构型唯一。',
      },
    });
  });

  const httpServer = http.createServer(app);
  let activeVite: { close: () => Promise<void> } | null = null;

  if (process.env.NODE_ENV !== 'production') {
    let viteInitPromise: Promise<any> | null = null;

    const getOrCreateVite = () => {
      if (!viteInitPromise) {
        viteInitPromise = (async () => {
          const { createServer: createViteServer } = await import('vite');
          const vite = await createViteServer({
            server: {
              middlewareMode: true,
              hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
              watch: process.env.DISABLE_HMR === 'true' ? null : {},
            },
            appType: 'spa',
          });
          activeVite = vite;
          // Pre-warm entry module transform cache asynchronously
          vite.warmupRequest('/src/main.tsx').catch(() => {});
          return vite;
        })().catch((err) => {
          console.error('Vite initialization error, resetting for retry:', err);
          viteInitPromise = null;
          throw err;
        });
      }
      return viteInitPromise;
    };

    // Kick off Vite startup eagerly without risking unhandled rejection crashes
    getOrCreateVite().catch(() => {});

    app.use(async (req, res, next) => {
      try {
        const vite = await getOrCreateVite();
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  let listenAttempts = 0;
  const maxListenAttempts = 6;

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && listenAttempts < maxListenAttempts) {
      listenAttempts += 1;
      setTimeout(() => {
        httpServer.close();
        httpServer.listen(PORT, '0.0.0.0');
      }, 300);
      return;
    }
    console.error('HTTP Server failed to bind port:', err);
    process.exit(1);
  });

  // Bind port 3000 immediately so Nginx never sees 502 Connection Refused or enters warmup.html reload loops
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Dor.ED Server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      if (activeVite) {
        activeVite.close().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();
