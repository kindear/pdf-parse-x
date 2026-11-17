import { getFormulaLlmConfig } from './formula-llm.js';

// The model returns a page-relative rectangle; invalid or uncertain results are
// rejected and the caller retains the page screenshot for manual inspection.
export async function locateFigureWithLlm(figure, screenshot, options = {}) {
  const config = getFormulaLlmConfig(options);
  if (!config.enabled || !config.baseUrl || !config.vision || !screenshot?.data) return null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      signal: controller.signal,
      body: JSON.stringify({ model: config.model, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: `Locate the complete figure associated with this caption: ${figure.caption}. Return only JSON {"box":[left,top,right,bottom],"confidence":number}. Confidence must be between 0 and 1. Coordinates must be integers from 0 to 1000 relative to the whole page, top-left origin. Exclude the caption and surrounding text. Include all figure panels. If uncertain or absent, return {"box":null,"confidence":0}.` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(screenshot.data).toString('base64')}` } }
      ] }] })
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const box = parsed.box;
    const confidence = parsed.confidence > 1 && parsed.confidence <= 100 ? parsed.confidence / 100 : parsed.confidence;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) ||
      !Number.isFinite(confidence) || confidence < 0.9 || confidence > 1 ||
      box[2] <= box[0] || box[3] <= box[1] || (box[2] - box[0]) * (box[3] - box[1]) < 10000) return null;
    return box;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
