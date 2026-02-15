import type { Spec, Scene, Layer } from "../schema/index.js";

/**
 * Build an FFmpeg filtergraph string from a parsed Spec.
 *
 * Strategy:
 *  1. Each scene produces a fixed-duration video segment.
 *  2. Text/image/video layers are overlaid via the overlay filter.
 *  3. Transitions between scenes use xfade.
 *  4. Audio tracks are mixed with amix / amerge.
 */

interface FiltergraphResult {
  inputs: string[];          // -i arguments (file paths / lavfi sources)
  filterComplex: string;     // the full -filter_complex value
  mapVideo: string;          // output pad label for video
  mapAudio: string;          // output pad label for audio
}

// ── Helpers ──────────────────────────────────────────────────────

function colorInput(hex: string, w: number, h: number, dur: number, fps: number): string {
  return `color=c=${hex}:s=${w}x${h}:d=${dur}:r=${fps}`;
}

function resolvePosition(
  pos: { x: number | string; y: number | string },
  canvasW: number,
  canvasH: number,
): { x: string; y: string } {
  const resolveAxis = (val: number | string, canvasDim: number, label: "w" | "h", overlayDim: "overlay_w" | "overlay_h" | "text_w" | "text_h") => {
    if (typeof val === "number") return String(val);
    switch (val) {
      case "center": return `(${label === "w" ? "W" : "H"}-${overlayDim})/2`;
      case "left":
      case "top":    return "0";
      case "right":  return `W-${overlayDim}`;
      case "bottom": return `H-${overlayDim}`;
      default:       return "0";
    }
  };
  return {
    x: resolveAxis(pos.x, canvasW, "w", "text_w"),
    y: resolveAxis(pos.y, canvasH, "h", "text_h"),
  };
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "\\\\%");
}

// ── Scene → filters ──────────────────────────────────────────────

function buildSceneFilters(
  scene: Scene,
  sceneIdx: number,
  inputIdx: number,
  spec: Spec,
): { filters: string[]; nextInput: number; outLabel: string } {
  const { width: W, height: H, fps } = spec.output;
  const filters: string[] = [];
  let currentLabel: string;

  // Background
  if (scene.background.type === "color") {
    const src = colorInput(scene.background.value, W, H, scene.duration, fps);
    filters.push(`${src},format=yuva420p[sc${sceneIdx}_bg]`);
    currentLabel = `sc${sceneIdx}_bg`;
  } else if (scene.background.type === "image") {
    filters.push(
      `[${inputIdx}]loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
      `trim=duration=${scene.duration},setpts=PTS-STARTPTS,format=yuva420p[sc${sceneIdx}_bg]`
    );
    currentLabel = `sc${sceneIdx}_bg`;
    inputIdx++;
  } else if (scene.background.type === "video") {
    const trimFrom = scene.background.trim?.from ?? 0;
    const trimEnd = trimFrom + scene.duration;
    filters.push(
      `[${inputIdx}]trim=start=${trimFrom}:end=${trimEnd},setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,format=yuva420p[sc${sceneIdx}_bg]`
    );
    currentLabel = `sc${sceneIdx}_bg`;
    inputIdx++;
  } else {
    // gradient — approximate with a static color for now
    const firstColor = (scene.background as { colors: string[] }).colors[0];
    const src = colorInput(firstColor, W, H, scene.duration, fps);
    filters.push(`${src},format=yuva420p[sc${sceneIdx}_bg]`);
    currentLabel = `sc${sceneIdx}_bg`;
  }

  // Layers
  scene.layers.forEach((layer, li) => {
    const layerLabel = `sc${sceneIdx}_l${li}`;
    const prevLabel = currentLabel;

    if (layer.type === "text") {
      const pos = resolvePosition(layer.position, W, H);
      const s = layer.style;
      const drawtext =
        `drawtext=text='${escapeText(layer.content)}'` +
        `:fontfile=${s.font}` +
        `:fontsize=${s.size}` +
        `:fontcolor=${s.color}` +
        `:borderw=${s.outline}` +
        `:bordercolor=${s.outlineColor}` +
        `:x=${pos.x}:y=${pos.y}`;
      const enable = layer.duration
        ? `:enable='between(t,${layer.start},${layer.start + layer.duration})'`
        : "";
      filters.push(`[${prevLabel}]${drawtext}${enable}[${layerLabel}]`);
      currentLabel = layerLabel;
    } else if (layer.type === "image") {
      const pos = resolvePosition(layer.position, W, H);
      const scaleW = layer.size.width === "auto" ? "-1" : String(layer.size.width);
      const scaleH = layer.size.height === "auto" ? "-1" : String(layer.size.height);
      filters.push(
        `[${inputIdx}]scale=${scaleW}:${scaleH},format=yuva420p[sc${sceneIdx}_img${li}]`
      );
      const enable = layer.duration
        ? `:enable='between(t,${layer.start},${layer.start + layer.duration})'`
        : "";
      filters.push(
        `[${prevLabel}][sc${sceneIdx}_img${li}]overlay=x=${pos.x}:y=${pos.y}${enable}[${layerLabel}]`
      );
      currentLabel = layerLabel;
      inputIdx++;
    } else if (layer.type === "video") {
      const pos = resolvePosition(layer.position, W, H);
      const trimFrom = layer.trim?.from ?? 0;
      const trimEnd = layer.trim?.to ? layer.trim.to : trimFrom + (layer.duration ?? scene.duration);
      const scaleW = layer.size.width === "auto" ? "-1" : String(layer.size.width);
      const scaleH = layer.size.height === "auto" ? "-1" : String(layer.size.height);
      filters.push(
        `[${inputIdx}]trim=start=${trimFrom}:end=${trimEnd},setpts=PTS-STARTPTS,` +
        `scale=${scaleW}:${scaleH},format=yuva420p[sc${sceneIdx}_vid${li}]`
      );
      const enable = layer.duration
        ? `:enable='between(t,${layer.start},${layer.start + layer.duration})'`
        : "";
      filters.push(
        `[${prevLabel}][sc${sceneIdx}_vid${li}]overlay=x=${pos.x}:y=${pos.y}${enable}[${layerLabel}]`
      );
      currentLabel = layerLabel;
      inputIdx++;
    } else if (layer.type === "shape") {
      // shapes are drawn as drawbox
      const x = typeof layer.position.x === "number" ? layer.position.x : 0;
      const y = typeof layer.position.y === "number" ? layer.position.y : 0;
      const w = layer.size.width === "auto" ? 100 : layer.size.width;
      const h = layer.size.height === "auto" ? 100 : layer.size.height;
      const alpha = Math.round(layer.opacity * 255);
      const enable = layer.duration
        ? `:enable='between(t,${layer.start},${layer.start + layer.duration})'`
        : "";
      filters.push(
        `[${prevLabel}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${layer.color}@${alpha / 255}:t=fill${enable}[${layerLabel}]`
      );
      currentLabel = layerLabel;
    }
  });

  return { filters, nextInput: inputIdx, outLabel: currentLabel };
}

// ── Public API ───────────────────────────────────────────────────

export function buildFiltergraph(spec: Spec, jobDir: string): FiltergraphResult {
  const { width: W, height: H, fps } = spec.output;
  const inputs: string[] = [];
  const allFilters: string[] = [];
  let inputIdx = 0;
  const sceneOutLabels: string[] = [];

  // Collect input files from scenes
  for (const scene of spec.scenes) {
    if (scene.background.type === "image" || scene.background.type === "video") {
      inputs.push(resolvePath(scene.background.src, jobDir));
    }
    for (const layer of scene.layers) {
      if ((layer.type === "image" || layer.type === "video") && "src" in layer) {
        inputs.push(resolvePath(layer.src, jobDir));
      }
    }
  }

  // Build per-scene filtergraph
  for (let i = 0; i < spec.scenes.length; i++) {
    // Reset inputIdx relative tracking — we compute from the collected inputs above
    const result = buildSceneFilters(spec.scenes[i], i, inputIdx, spec);
    allFilters.push(...result.filters);
    sceneOutLabels.push(result.outLabel);
    inputIdx = result.nextInput;
  }

  // Chain scenes with xfade transitions
  let videoOut: string;
  if (sceneOutLabels.length === 1) {
    videoOut = sceneOutLabels[0];
  } else {
    let prevLabel = sceneOutLabels[0];
    let cumulativeOffset = spec.scenes[0].duration;

    for (let i = 1; i < sceneOutLabels.length; i++) {
      const transition = spec.scenes[i - 1].transition;
      const tType = mapTransitionType(transition.type);
      const tDur = transition.duration;
      const offset = Math.max(0, cumulativeOffset - tDur);
      const outLabel = `xfade${i}`;

      allFilters.push(
        `[${prevLabel}][${sceneOutLabels[i]}]xfade=transition=${tType}:duration=${tDur}:offset=${offset}[${outLabel}]`
      );

      prevLabel = outLabel;
      cumulativeOffset += spec.scenes[i].duration - tDur;
    }
    videoOut = prevLabel;
  }

  // Audio tracks
  const audioInputStart = inputs.length;
  const audioLabels: string[] = [];
  for (let i = 0; i < spec.audio.tracks.length; i++) {
    const track = spec.audio.tracks[i];
    inputs.push(resolvePath(track.src, jobDir));
    const aidx = audioInputStart + i;
    const label = `aud${i}`;

    let audioFilter = `[${aidx}]`;
    const parts: string[] = [];

    if (track.trim.from > 0 || track.trim.to) {
      const trimEnd = track.trim.to ? `:end=${track.trim.to}` : "";
      parts.push(`atrim=start=${track.trim.from}${trimEnd},asetpts=PTS-STARTPTS`);
    }
    if (track.volume !== 1) {
      parts.push(`volume=${track.volume}`);
    }
    if (track.fadeIn > 0) {
      parts.push(`afade=t=in:d=${track.fadeIn}`);
    }
    if (track.fadeOut > 0) {
      parts.push(`afade=t=out:d=${track.fadeOut}:st=0`);
    }
    if (track.start > 0) {
      parts.push(`adelay=${Math.round(track.start * 1000)}|${Math.round(track.start * 1000)}`);
    }

    if (parts.length > 0) {
      audioFilter += parts.join(",");
    } else {
      audioFilter += "anull";
    }
    audioFilter += `[${label}]`;
    allFilters.push(audioFilter);
    audioLabels.push(label);
  }

  let audioOut = "audio_out";
  if (audioLabels.length === 0) {
    allFilters.push(`anullsrc=r=44100:cl=stereo,atrim=duration=1[${audioOut}]`);
  } else if (audioLabels.length === 1) {
    audioOut = audioLabels[0];
  } else {
    const mixInputs = audioLabels.map((l) => `[${l}]`).join("");
    allFilters.push(`${mixInputs}amix=inputs=${audioLabels.length}:dropout_transition=0[${audioOut}]`);
  }

  return {
    inputs,
    filterComplex: allFilters.join(";\n"),
    mapVideo: videoOut,
    mapAudio: audioOut,
  };
}

function resolvePath(src: string, jobDir: string): string {
  if (src.startsWith("/")) return src;
  return `${jobDir}/${src}`;
}

function mapTransitionType(t: string): string {
  const map: Record<string, string> = {
    "none": "fade",
    "crossfade": "fade",
    "wipe-left": "wipeleft",
    "wipe-right": "wiperight",
    "wipe-up": "wipeup",
    "wipe-down": "wipedown",
    "fade-black": "fadeblack",
  };
  return map[t] ?? "fade";
}
