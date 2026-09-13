import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: M-VAVE SMK-25 MIDI Keyboard
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createMVAVESMK25MIDIKeyboardModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "M-VAVE SMK-25 MIDI Keyboard";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 38, "aspect": 1.6, "orientation": {"yaw": 0, "pitch": -1.35, "roll": 0}, "positionHint": [0, 3.2, 0.6], "note": "Top-down orthographic-like reference; review from top + 3/4 + rear."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["body-abs"] = createSculptMaterial(
    "body-abs",
    {"id": "body-abs", "name": "White satin ABS chassis", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F2F3F4", "color": "#F2F3F4", "albedo": {"dominant": "#F2F3F4", "secondary": ["#D8DCE0", "#FFFFFF"], "samplingNotes": "Top-view white deck under softbox; sidewalls slightly darker from AO."}, "colorVariation": {"palette": ["#F2F3F4", "#E4E7EA", "#FFFFFF"], "pattern": "fine-grain", "amplitude": 0.04, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.2, "role": "panel tone breakup"}, {"id": "meso", "frequency": 14, "amplitude": 0.12, "role": "orange-peel grain"}, {"id": "micro", "frequency": 60, "amplitude": 0.05, "role": "highlight breakup"}], "roughness": {"base": 0.46, "variation": 0.1, "map": "independent-procedural-field", "localResponse": "higher in recesses, lower on key tops"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.18, "scale": 18, "space": "tangent"}, "bump": {"pattern": "procedural-grain", "amplitude": 0.04, "scale": 6}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.4, "notes": "Darken key slots, strip recesses, pad wells, knob skirts."}, "wear": {"edgeWear": 0.12, "scratches": ["deck micro-scuffs"], "chips": []}, "dirt": {"amount": 0.06, "cavityBias": 0.4, "color": "#3A3F45"}, "localOverrides": [{"id": "deck-satin", "description": "Top deck satin grain", "color": "#F2F3F4", "roughness": 0.46}, {"id": "slot-ao", "description": "Key slot cavity darkening", "color": "#C9CDD2", "roughness": 0.7}, {"id": "rear-print", "description": "Rear SMK-25 logotype dark gray", "color": "#2E3440", "roughness": 0.6}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO channels; never alias albedo into roughness."], "notes": "White satin ABS chassis"},
    options
  );
  materialMap["key-white"] = createSculptMaterial(
    "key-white",
    {"id": "key-white", "name": "White key ABS", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F7F8F9", "color": "#F7F8F9", "albedo": {"dominant": "#F7F8F9", "secondary": ["#E2E5E9", "#FFFFFF"], "samplingNotes": "Key tops near-white with soft gradient to sidewall."}, "colorVariation": {"palette": ["#F7F8F9", "#E8EBEF", "#FFFFFF"], "pattern": "smooth", "amplitude": 0.02, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.1, "role": "key tone"}, {"id": "meso", "frequency": 10, "amplitude": 0.06, "role": "mold witness"}, {"id": "micro", "frequency": 48, "amplitude": 0.03, "role": "highlight breakup"}], "roughness": {"base": 0.34, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "polished tops, rougher sidewalls"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.1, "scale": 12, "space": "tangent"}, "bump": {"pattern": "procedural-grain", "amplitude": 0.02, "scale": 4}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.45, "contactShadowBias": 0.4, "notes": "Slot contact AO under each key."}, "wear": {"edgeWear": 0.15, "scratches": ["key front-edge polish"], "chips": []}, "dirt": {"amount": 0.04, "cavityBias": 0.5, "color": "#2F2A22"}, "localOverrides": [{"id": "key-top", "description": "Polished key top", "color": "#FFFFFF", "roughness": 0.3}, {"id": "key-side", "description": "Sidewall matte + witness line", "color": "#E8EBEF", "roughness": 0.5}], "shaderNotes": ["Independent channels."], "notes": "White keys"},
    options
  );
  materialMap["key-black"] = createSculptMaterial(
    "key-black",
    {"id": "key-black", "name": "Black key gloss ABS", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#14171B", "color": "#14171B", "albedo": {"dominant": "#14171B", "secondary": ["#2A2F36", "#000000"], "samplingNotes": "Near-black with top specular streak."}, "colorVariation": {"palette": ["#14171B", "#23282E", "#0A0C0E"], "pattern": "smooth", "amplitude": 0.05, "heightCorrelation": 0.2}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "tone"}, {"id": "meso", "frequency": 12, "amplitude": 0.08, "role": "chamfer highlight"}, {"id": "micro", "frequency": 50, "amplitude": 0.04, "role": "gloss breakup"}], "roughness": {"base": 0.28, "variation": 0.1, "map": "independent-procedural-field", "localResponse": "gloss tops, satin sides"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.12, "scale": 12, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.35, "notes": "Base contact AO."}, "wear": {"edgeWear": 0.2, "scratches": ["top gloss scuffs"], "chips": []}, "dirt": {"amount": 0.05, "cavityBias": 0.4, "color": "#000000"}, "localOverrides": [{"id": "black-top-gloss", "description": "Gloss top streak", "color": "#1E2228", "roughness": 0.22}, {"id": "black-side", "description": "Satin sidewalls", "color": "#101317", "roughness": 0.42}], "shaderNotes": ["Independent channels."], "notes": "Black keys"},
    options
  );
  materialMap["pad-silicone"] = createSculptMaterial(
    "pad-silicone",
    {"id": "pad-silicone", "name": "Translucent silicone pads + emissive", "type": "standard", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "baseColor": "#BFEFEF", "color": "#BFEFEF", "albedo": {"dominant": "#BFEFEF", "secondary": ["#D9C2F5", "#FFFFFF"], "samplingNotes": "Unlit silicone milky; lit cyan row 1 / lavender row 2."}, "colorVariation": {"palette": ["#BFEFEF", "#D9C2F5", "#EAFBFB"], "pattern": "radial-glow", "amplitude": 0.3, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.2, "role": "lens dome"}, {"id": "meso", "frequency": 8, "amplitude": 0.1, "role": "lens meniscus"}, {"id": "micro", "frequency": 40, "amplitude": 0.04, "role": "soft-touch grain"}], "roughness": {"base": 0.55, "variation": 0.12, "map": "independent-procedural-field", "localResponse": "soft-touch matte with glossy hot center"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.15, "scale": 10, "space": "tangent"}, "bump": {"pattern": "procedural-grain", "amplitude": 0.03, "scale": 4}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.35, "contactShadowBias": 0.35, "notes": "Pad well AO ring."}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.3, "color": "#3A4A4A"}, "localOverrides": [{"id": "pad-cyan", "description": "Cyan emissive core row 1", "color": "#7DE8E8", "roughness": 0.4}, {"id": "pad-lavender", "description": "Lavender emissive core row 2", "color": "#D3B3F2", "roughness": 0.4}, {"id": "pad-skirt", "description": "Milky silicone skirt", "color": "#E8F4F4", "roughness": 0.65}], "shaderNotes": ["Emissive cores are separate emissive material-state meshes; never bake glow into albedo only."], "notes": "Pads"},
    options
  );
  materialMap["knob-black"] = createSculptMaterial(
    "knob-black",
    {"id": "knob-black", "name": "Rubberized black knobs", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#1C1E22", "color": "#1C1E22", "albedo": {"dominant": "#1C1E22", "secondary": ["#33363C", "#0C0D0F"], "samplingNotes": "Matte black with flute highlights."}, "colorVariation": {"palette": ["#1C1E22", "#2A2D33", "#0C0D0F"], "pattern": "fluted", "amplitude": 0.12, "heightCorrelation": 0.4}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.2, "role": "flute lobes"}, {"id": "meso", "frequency": 16, "amplitude": 0.15, "role": "grip ribs"}, {"id": "micro", "frequency": 56, "amplitude": 0.05, "role": "matte grain"}], "roughness": {"base": 0.62, "variation": 0.12, "map": "independent-procedural-field", "localResponse": "rougher flanks, polished top ring"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.3, "scale": 16, "space": "tangent"}, "bump": {"pattern": "procedural-grain", "amplitude": 0.05, "scale": 5}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.45, "contactShadowBias": 0.4, "notes": "Flute valley AO + skirt contact."}, "wear": {"edgeWear": 0.18, "scratches": ["knurl crest polish"], "chips": []}, "dirt": {"amount": 0.08, "cavityBias": 0.5, "color": "#000000"}, "localOverrides": [{"id": "flute-valley", "description": "Dark flute valleys", "color": "#0E0F12", "roughness": 0.72}, {"id": "pointer-mark", "description": "White pointer inlay", "color": "#EDEFF2", "roughness": 0.5}], "shaderNotes": ["Flutes are geometry, not normal-only, because they affect silhouette."], "notes": "Knobs"},
    options
  );
  materialMap["button-gray"] = createSculptMaterial(
    "button-gray",
    {"id": "button-gray", "name": "Light-gray buttons", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#E9EBEE", "color": "#E9EBEE", "albedo": {"dominant": "#E9EBEE", "secondary": ["#C9CDD3", "#BFD4FF"], "samplingNotes": "Light gray caps; BT cap pale blue."}, "colorVariation": {"palette": ["#E9EBEE", "#D5D9DF", "#D6E4FF"], "pattern": "smooth", "amplitude": 0.04, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.1, "role": "cap tone"}, {"id": "meso", "frequency": 10, "amplitude": 0.06, "role": "cap edge"}, {"id": "micro", "frequency": 44, "amplitude": 0.03, "role": "highlight breakup"}], "roughness": {"base": 0.5, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin caps"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.1, "scale": 10, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.35, "contactShadowBias": 0.35, "notes": "Button well AO."}, "wear": {"edgeWear": 0.1, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.3, "color": "#3A3F45"}, "localOverrides": [{"id": "bt-tint", "description": "BT button pale-blue tint", "color": "#C7D8FF", "roughness": 0.5}, {"id": "legend-ink", "description": "Dark gray legend ink", "color": "#3A4048", "roughness": 0.6}], "shaderNotes": ["Legends are decal geometry planes."], "notes": "Buttons"},
    options
  );
  materialMap["lcd-glass"] = createSculptMaterial(
    "lcd-glass",
    {"id": "lcd-glass", "name": "LCD glass + emissive glyph", "type": "standard", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "baseColor": "#05070A", "color": "#05070A", "albedo": {"dominant": "#05070A", "secondary": ["#0E1A26", "#9FD0FF"], "samplingNotes": "Black glass with blue-white 7-seg glyphs."}, "colorVariation": {"palette": ["#05070A", "#10202F", "#BFE0FF"], "pattern": "glyph", "amplitude": 0.4, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "Preserve stable world/object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.15, "role": "glass tone"}, {"id": "meso", "frequency": 10, "amplitude": 0.08, "role": "bezel step"}, {"id": "micro", "frequency": 48, "amplitude": 0.03, "role": "glass streak"}], "roughness": {"base": 0.16, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "gloss glass, matte bezel"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.08, "scale": 8, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.5, "contactShadowBias": 0.4, "notes": "Bezel recess AO."}, "wear": {"edgeWear": 0.05, "scratches": ["glass micro-streak"], "chips": []}, "dirt": {"amount": 0.02, "cavityBias": 0.3, "color": "#000000"}, "localOverrides": [{"id": "glyph-emissive", "description": "Blue-white 7-seg Pr1 glyphs", "color": "#CFE6FF", "roughness": 0.3}, {"id": "bezel-matte", "description": "Matte bezel frame", "color": "#14171B", "roughness": 0.6}], "shaderNotes": ["Glyphs use emissive material-state; glass uses clearcoat-like low roughness."], "notes": "LCD"},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "M-VAVE SMK-25 root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "M-VAVE SMK-25 root", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Root is an assembly of chassis + keybed + control deck solids, not a continuous sculpt.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 3.2, "height": 0.35, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_root_0.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "M-VAVE SMK-25 root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "M-VAVE SMK-25 root", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Root is an assembly of chassis + keybed + control deck solids, not a continuous sculpt.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 3.2, "height": 0.35, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_root_0);

  const endpoint_chassis_body_1 = makeAttachmentEndpoint(null);
  const node_chassis_body_1 = new THREE.Group();
  node_chassis_body_1.name = "Chassis shell__pivot";
  node_chassis_body_1.scale.set(1, 1, 1);
  if (endpoint_chassis_body_1) {
    node_chassis_body_1.position.copy(endpoint_chassis_body_1.start);
    node_chassis_body_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chassis_body_1.position.set(0.0, 0.0, 0.0);
    node_chassis_body_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_chassis_body_1.userData.sculptComponent = {"id": "chassis-body", "name": "Chassis shell", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Chassis is a low rounded-corner cuboid shell with top deck + sidewalls + rear IO face.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "chassis-seat", "localStart": [0, -0.1, 0], "localEnd": [0, 0.1, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.2, "height": 0.35, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "edge-fillet", "description": "3mm rounded fillet on all top edges"}, {"id": "rear-face", "description": "Rear vertical face with IO cutouts + SMK-25 print"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_chassis_body_1.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_chassis_body_1);
  nodes["chassis-body"] = node_chassis_body_1;
  const mesh_chassis_body_1Geometry = endpoint_chassis_body_1
    ? new THREE.CylinderGeometry(endpoint_chassis_body_1.endRadius, endpoint_chassis_body_1.baseRadius, endpoint_chassis_body_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chassis_body_1) {
    mesh_chassis_body_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chassis_body_1 = new THREE.Mesh(
    mesh_chassis_body_1Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chassis_body_1.name = "Chassis shell";
  if (endpoint_chassis_body_1) {
    mesh_chassis_body_1.position.copy(endpoint_chassis_body_1.midpoint);
    mesh_chassis_body_1.quaternion.copy(endpoint_chassis_body_1.quaternion);
  }
  mesh_chassis_body_1.castShadow = options.castShadow ?? true;
  mesh_chassis_body_1.receiveShadow = options.receiveShadow ?? true;
  mesh_chassis_body_1.userData.sculptComponent = {"id": "chassis-body", "name": "Chassis shell", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Chassis is a low rounded-corner cuboid shell with top deck + sidewalls + rear IO face.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "chassis-seat", "localStart": [0, -0.1, 0], "localEnd": [0, 0.1, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.2, "height": 0.35, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "edge-fillet", "description": "3mm rounded fillet on all top edges"}, {"id": "rear-face", "description": "Rear vertical face with IO cutouts + SMK-25 print"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_chassis_body_1.add(mesh_chassis_body_1);
  meshes["chassis-body"] = mesh_chassis_body_1;
  colliders["chassis-body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_chassis_body_1);

  const endpoint_keybed_assembly_2 = makeAttachmentEndpoint(null);
  const node_keybed_assembly_2 = new THREE.Group();
  node_keybed_assembly_2.name = "Keybed assembly__pivot";
  node_keybed_assembly_2.scale.set(1, 1, 1);
  if (endpoint_keybed_assembly_2) {
    node_keybed_assembly_2.position.copy(endpoint_keybed_assembly_2.start);
    node_keybed_assembly_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_keybed_assembly_2.position.set(0.0, -0.02, 0.48);
    node_keybed_assembly_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_keybed_assembly_2.userData.sculptComponent = {"id": "keybed-assembly", "name": "Keybed assembly", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Keybed is a recessed slot field carrying 25 independent key solids.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "keybed-seat", "localStart": [0, -0.05, 0.45], "localEnd": [0, 0.1, 0.45], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.78, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.02, 0.48], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs", "key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-slots", "description": "25 recessed key slots with cavity AO"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_keybed_assembly_2.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_keybed_assembly_2);
  nodes["keybed-assembly"] = node_keybed_assembly_2;
  const mesh_keybed_assembly_2Geometry = endpoint_keybed_assembly_2
    ? new THREE.CylinderGeometry(endpoint_keybed_assembly_2.endRadius, endpoint_keybed_assembly_2.baseRadius, endpoint_keybed_assembly_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_keybed_assembly_2) {
    mesh_keybed_assembly_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_keybed_assembly_2 = new THREE.Mesh(
    mesh_keybed_assembly_2Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_keybed_assembly_2.name = "Keybed assembly";
  if (endpoint_keybed_assembly_2) {
    mesh_keybed_assembly_2.position.copy(endpoint_keybed_assembly_2.midpoint);
    mesh_keybed_assembly_2.quaternion.copy(endpoint_keybed_assembly_2.quaternion);
  }
  mesh_keybed_assembly_2.castShadow = options.castShadow ?? true;
  mesh_keybed_assembly_2.receiveShadow = options.receiveShadow ?? true;
  mesh_keybed_assembly_2.userData.sculptComponent = {"id": "keybed-assembly", "name": "Keybed assembly", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Keybed is a recessed slot field carrying 25 independent key solids.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "keybed-seat", "localStart": [0, -0.05, 0.45], "localEnd": [0, 0.1, 0.45], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.12, "depth": 0.78, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.02, 0.48], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs", "key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-slots", "description": "25 recessed key slots with cavity AO"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_keybed_assembly_2.add(mesh_keybed_assembly_2);
  meshes["keybed-assembly"] = mesh_keybed_assembly_2;
  colliders["keybed-assembly"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_keybed_assembly_2);

  const endpoint_control_panel_3 = makeAttachmentEndpoint(null);
  const node_control_panel_3 = new THREE.Group();
  node_control_panel_3.name = "Control deck assembly__pivot";
  node_control_panel_3.scale.set(1, 1, 1);
  if (endpoint_control_panel_3) {
    node_control_panel_3.position.copy(endpoint_control_panel_3.start);
    node_control_panel_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_control_panel_3.position.set(0.0, 0.15, -0.35);
    node_control_panel_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_control_panel_3.userData.sculptComponent = {"id": "control-panel", "name": "Control deck assembly", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Control deck is a flat panel carrying pads/knobs/buttons/display/strips as socketed children.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "deck-seat", "localStart": [0, 0.12, -0.35], "localEnd": [0, 0.18, -0.35], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.06, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.15, -0.35], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "deck-plate", "description": "Flat top plate with silkscreen legends + M-VAVE logo"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_control_panel_3.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_control_panel_3);
  nodes["control-panel"] = node_control_panel_3;
  const mesh_control_panel_3Geometry = endpoint_control_panel_3
    ? new THREE.CylinderGeometry(endpoint_control_panel_3.endRadius, endpoint_control_panel_3.baseRadius, endpoint_control_panel_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_control_panel_3) {
    mesh_control_panel_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_control_panel_3 = new THREE.Mesh(
    mesh_control_panel_3Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_control_panel_3.name = "Control deck assembly";
  if (endpoint_control_panel_3) {
    mesh_control_panel_3.position.copy(endpoint_control_panel_3.midpoint);
    mesh_control_panel_3.quaternion.copy(endpoint_control_panel_3.quaternion);
  }
  mesh_control_panel_3.castShadow = options.castShadow ?? true;
  mesh_control_panel_3.receiveShadow = options.receiveShadow ?? true;
  mesh_control_panel_3.userData.sculptComponent = {"id": "control-panel", "name": "Control deck assembly", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Control deck is a flat panel carrying pads/knobs/buttons/display/strips as socketed children.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "deck-seat", "localStart": [0, 0.12, -0.35], "localEnd": [0, 0.18, -0.35], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.06, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.15, -0.35], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "deck-plate", "description": "Flat top plate with silkscreen legends + M-VAVE logo"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_control_panel_3.add(mesh_control_panel_3);
  meshes["control-panel"] = mesh_control_panel_3;
  colliders["control-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_control_panel_3);

  const endpoint_white_key_row_4 = makeAttachmentEndpoint(null);
  const node_white_key_row_4 = new THREE.Group();
  node_white_key_row_4.name = "White key row (15x)__pivot";
  node_white_key_row_4.scale.set(1, 1, 1);
  if (endpoint_white_key_row_4) {
    node_white_key_row_4.position.copy(endpoint_white_key_row_4.start);
    node_white_key_row_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_white_key_row_4.position.set(0.0, 0.03, 0.02);
    node_white_key_row_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_white_key_row_4.userData.sculptComponent = {"id": "white-key-row", "name": "White key row (15x)", "level": "meso", "role": "key-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is a linear array of 15 independent key solids with uniform seams.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keybed-assembly", "attachment": {"parentId": "keybed-assembly", "parentSocket": "white-row-seat", "localStart": [-1.4, 0, 0], "localEnd": [1.4, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.9, "height": 0.1, "depth": 0.7, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-white", "materialLayers": ["key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-gaps", "description": "0.8mm inter-key seams with recessed shadow"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_white_key_row_4.userData.actionProfile = {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["keybed-assembly"] ?? root).add(node_white_key_row_4);
  nodes["white-key-row"] = node_white_key_row_4;
  const mesh_white_key_row_4Geometry = endpoint_white_key_row_4
    ? new THREE.CylinderGeometry(endpoint_white_key_row_4.endRadius, endpoint_white_key_row_4.baseRadius, endpoint_white_key_row_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_white_key_row_4) {
    mesh_white_key_row_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_white_key_row_4 = new THREE.Mesh(
    mesh_white_key_row_4Geometry,
    materialMap["key-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_white_key_row_4.name = "White key row (15x)";
  if (endpoint_white_key_row_4) {
    mesh_white_key_row_4.position.copy(endpoint_white_key_row_4.midpoint);
    mesh_white_key_row_4.quaternion.copy(endpoint_white_key_row_4.quaternion);
  }
  mesh_white_key_row_4.castShadow = options.castShadow ?? true;
  mesh_white_key_row_4.receiveShadow = options.receiveShadow ?? true;
  mesh_white_key_row_4.userData.sculptComponent = {"id": "white-key-row", "name": "White key row (15x)", "level": "meso", "role": "key-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is a linear array of 15 independent key solids with uniform seams.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keybed-assembly", "attachment": {"parentId": "keybed-assembly", "parentSocket": "white-row-seat", "localStart": [-1.4, 0, 0], "localEnd": [1.4, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.9, "height": 0.1, "depth": 0.7, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.03, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-white", "materialLayers": ["key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-gaps", "description": "0.8mm inter-key seams with recessed shadow"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_white_key_row_4.add(mesh_white_key_row_4);
  meshes["white-key-row"] = mesh_white_key_row_4;
  colliders["white-key-row"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_white_key_row_4);

  const endpoint_black_key_row_5 = makeAttachmentEndpoint(null);
  const node_black_key_row_5 = new THREE.Group();
  node_black_key_row_5.name = "Black key row (10x)__pivot";
  node_black_key_row_5.scale.set(1, 1, 1);
  if (endpoint_black_key_row_5) {
    node_black_key_row_5.position.copy(endpoint_black_key_row_5.start);
    node_black_key_row_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_black_key_row_5.position.set(0.0, 0.1, -0.12);
    node_black_key_row_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_black_key_row_5.userData.sculptComponent = {"id": "black-key-row", "name": "Black key row (10x)", "level": "meso", "role": "key-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is 10 elevated black solids in 2-3 groups above white-key plane.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keybed-assembly", "attachment": {"parentId": "keybed-assembly", "parentSocket": "black-row-seat", "localStart": [-1.2, 0.08, -0.1], "localEnd": [1.2, 0.08, -0.1], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.6, "height": 0.14, "depth": 0.4, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.1, -0.12], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-black", "materialLayers": ["key-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-chamfer", "description": "Front chamfer + top gloss on each black key"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17,20,23,1.0)", "secondaryAlbedo": "rgba(45,50,56,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_black_key_row_5.userData.actionProfile = {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["keybed-assembly"] ?? root).add(node_black_key_row_5);
  nodes["black-key-row"] = node_black_key_row_5;
  const mesh_black_key_row_5Geometry = endpoint_black_key_row_5
    ? new THREE.CylinderGeometry(endpoint_black_key_row_5.endRadius, endpoint_black_key_row_5.baseRadius, endpoint_black_key_row_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_black_key_row_5) {
    mesh_black_key_row_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_black_key_row_5 = new THREE.Mesh(
    mesh_black_key_row_5Geometry,
    materialMap["key-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_key_row_5.name = "Black key row (10x)";
  if (endpoint_black_key_row_5) {
    mesh_black_key_row_5.position.copy(endpoint_black_key_row_5.midpoint);
    mesh_black_key_row_5.quaternion.copy(endpoint_black_key_row_5.quaternion);
  }
  mesh_black_key_row_5.castShadow = options.castShadow ?? true;
  mesh_black_key_row_5.receiveShadow = options.receiveShadow ?? true;
  mesh_black_key_row_5.userData.sculptComponent = {"id": "black-key-row", "name": "Black key row (10x)", "level": "meso", "role": "key-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is 10 elevated black solids in 2-3 groups above white-key plane.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keybed-assembly", "attachment": {"parentId": "keybed-assembly", "parentSocket": "black-row-seat", "localStart": [-1.2, 0.08, -0.1], "localEnd": [1.2, 0.08, -0.1], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.6, "height": 0.14, "depth": 0.4, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.1, -0.12], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-black", "materialLayers": ["key-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "key-chamfer", "description": "Front chamfer + top gloss on each black key"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17,20,23,1.0)", "secondaryAlbedo": "rgba(45,50,56,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_black_key_row_5.add(mesh_black_key_row_5);
  meshes["black-key-row"] = mesh_black_key_row_5;
  colliders["black-key-row"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_black_key_row_5);

  const endpoint_pad_grid_6 = makeAttachmentEndpoint(null);
  const node_pad_grid_6 = new THREE.Group();
  node_pad_grid_6.name = "Pad grid 4x2__pivot";
  node_pad_grid_6.scale.set(1, 1, 1);
  if (endpoint_pad_grid_6) {
    node_pad_grid_6.position.copy(endpoint_pad_grid_6.start);
    node_pad_grid_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pad_grid_6.position.set(0.88, 0.04, -0.15);
    node_pad_grid_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_pad_grid_6.userData.sculptComponent = {"id": "pad-grid", "name": "Pad grid 4x2", "level": "meso", "role": "pad-grid", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Grid is 8 translucent silicone lenses in 4x2 array with emissive cores.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "pad-seat", "localStart": [0.35, 0, 0], "localEnd": [1.35, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.35, "height": 0.05, "depth": 0.62, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.88, 0.04, -0.15], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pad-grid", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pad-silicone", "materialLayers": ["pad-silicone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pad-lens", "description": "Rounded-square silicone lens, 2mm corner radius, cyan/lavender emissive"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160,230,230,1.0)", "secondaryAlbedo": "rgba(215,185,245,1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85}};
  node_pad_grid_6.userData.actionProfile = {"animationRole": "pad-grid", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_pad_grid_6);
  nodes["pad-grid"] = node_pad_grid_6;
  const mesh_pad_grid_6Geometry = endpoint_pad_grid_6
    ? new THREE.CylinderGeometry(endpoint_pad_grid_6.endRadius, endpoint_pad_grid_6.baseRadius, endpoint_pad_grid_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_pad_grid_6) {
    mesh_pad_grid_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pad_grid_6 = new THREE.Mesh(
    mesh_pad_grid_6Geometry,
    materialMap["pad-silicone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pad_grid_6.name = "Pad grid 4x2";
  if (endpoint_pad_grid_6) {
    mesh_pad_grid_6.position.copy(endpoint_pad_grid_6.midpoint);
    mesh_pad_grid_6.quaternion.copy(endpoint_pad_grid_6.quaternion);
  }
  mesh_pad_grid_6.castShadow = options.castShadow ?? true;
  mesh_pad_grid_6.receiveShadow = options.receiveShadow ?? true;
  mesh_pad_grid_6.userData.sculptComponent = {"id": "pad-grid", "name": "Pad grid 4x2", "level": "meso", "role": "pad-grid", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Grid is 8 translucent silicone lenses in 4x2 array with emissive cores.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "pad-seat", "localStart": [0.35, 0, 0], "localEnd": [1.35, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.35, "height": 0.05, "depth": 0.62, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.88, 0.04, -0.15], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pad-grid", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pad-silicone", "materialLayers": ["pad-silicone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pad-lens", "description": "Rounded-square silicone lens, 2mm corner radius, cyan/lavender emissive"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160,230,230,1.0)", "secondaryAlbedo": "rgba(215,185,245,1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85}};
  node_pad_grid_6.add(mesh_pad_grid_6);
  meshes["pad-grid"] = mesh_pad_grid_6;
  colliders["pad-grid"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_pad_grid_6);

  const attachment_knob_cluster_7 = {"parentId": "control-panel", "parentSocket": "knob-seat", "localStart": [-1.2, 0, 0], "localEnd": [0.1, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]};
  const endpoint_knob_cluster_7 = makeAttachmentEndpoint(attachment_knob_cluster_7);
  const node_knob_cluster_7 = new THREE.Group();
  node_knob_cluster_7.name = "Knob cluster 4x2__pivot";
  node_knob_cluster_7.scale.set(1, 1, 1);
  if (endpoint_knob_cluster_7) {
    node_knob_cluster_7.position.copy(endpoint_knob_cluster_7.start);
    node_knob_cluster_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knob_cluster_7.position.set(-0.55, 0.06, -0.2);
    node_knob_cluster_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_knob_cluster_7.userData.sculptComponent = {"id": "knob-cluster", "name": "Knob cluster 4x2", "level": "meso", "role": "knob-cluster", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Cluster is 8 fluted cylinders on sockets with pointer legends.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "knob-seat", "localStart": [-1.2, 0, 0], "localEnd": [0.1, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.3, "height": 0.12, "depth": 0.55, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.55, 0.06, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "knob-cluster", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "knob-flutes", "description": "Octagonal flutes + radial ribs + pointer notch"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_knob_cluster_7.userData.actionProfile = {"animationRole": "knob-cluster", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_knob_cluster_7);
  nodes["knob-cluster"] = node_knob_cluster_7;
  const mesh_knob_cluster_7Geometry = endpoint_knob_cluster_7
    ? new THREE.CylinderGeometry(endpoint_knob_cluster_7.endRadius, endpoint_knob_cluster_7.baseRadius, endpoint_knob_cluster_7.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_knob_cluster_7) {
    mesh_knob_cluster_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_knob_cluster_7 = new THREE.Mesh(
    mesh_knob_cluster_7Geometry,
    materialMap["knob-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knob_cluster_7.name = "Knob cluster 4x2";
  if (endpoint_knob_cluster_7) {
    mesh_knob_cluster_7.position.copy(endpoint_knob_cluster_7.midpoint);
    mesh_knob_cluster_7.quaternion.copy(endpoint_knob_cluster_7.quaternion);
  }
  mesh_knob_cluster_7.castShadow = options.castShadow ?? true;
  mesh_knob_cluster_7.receiveShadow = options.receiveShadow ?? true;
  mesh_knob_cluster_7.userData.sculptComponent = {"id": "knob-cluster", "name": "Knob cluster 4x2", "level": "meso", "role": "knob-cluster", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Cluster is 8 fluted cylinders on sockets with pointer legends.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "knob-seat", "localStart": [-1.2, 0, 0], "localEnd": [0.1, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.3, "height": 0.12, "depth": 0.55, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.55, 0.06, -0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "knob-cluster", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "knob-flutes", "description": "Octagonal flutes + radial ribs + pointer notch"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_knob_cluster_7.add(mesh_knob_cluster_7);
  meshes["knob-cluster"] = mesh_knob_cluster_7;
  colliders["knob-cluster"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_knob_cluster_7);

  const endpoint_transport_row_8 = makeAttachmentEndpoint(null);
  const node_transport_row_8 = new THREE.Group();
  node_transport_row_8.name = "Transport + mode buttons 8x__pivot";
  node_transport_row_8.scale.set(1, 1, 1);
  if (endpoint_transport_row_8) {
    node_transport_row_8.position.copy(endpoint_transport_row_8.start);
    node_transport_row_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_transport_row_8.position.set(-0.58, 0.035, -0.62);
    node_transport_row_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_transport_row_8.userData.sculptComponent = {"id": "transport-row", "name": "Transport + mode buttons 8x", "level": "meso", "role": "button-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is 8 rounded-rect buttons with legends around display.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "transport-seat", "localStart": [-1.05, 0, 0.1], "localEnd": [-0.1, 0, 0.1], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 0.04, "depth": 0.3, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.58, 0.035, -0.62], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "button-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "button-legends", "description": "PLAY/STOP/REC/BT/ARP/SC-CH/KNOB-B/PAD-B legends, BT light-blue"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_transport_row_8.userData.actionProfile = {"animationRole": "button-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_transport_row_8);
  nodes["transport-row"] = node_transport_row_8;
  const mesh_transport_row_8Geometry = endpoint_transport_row_8
    ? new THREE.CylinderGeometry(endpoint_transport_row_8.endRadius, endpoint_transport_row_8.baseRadius, endpoint_transport_row_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_transport_row_8) {
    mesh_transport_row_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_transport_row_8 = new THREE.Mesh(
    mesh_transport_row_8Geometry,
    materialMap["button-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_transport_row_8.name = "Transport + mode buttons 8x";
  if (endpoint_transport_row_8) {
    mesh_transport_row_8.position.copy(endpoint_transport_row_8.midpoint);
    mesh_transport_row_8.quaternion.copy(endpoint_transport_row_8.quaternion);
  }
  mesh_transport_row_8.castShadow = options.castShadow ?? true;
  mesh_transport_row_8.receiveShadow = options.receiveShadow ?? true;
  mesh_transport_row_8.userData.sculptComponent = {"id": "transport-row", "name": "Transport + mode buttons 8x", "level": "meso", "role": "button-row", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Row is 8 rounded-rect buttons with legends around display.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "transport-seat", "localStart": [-1.05, 0, 0.1], "localEnd": [-0.1, 0, 0.1], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 0.04, "depth": 0.3, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.58, 0.035, -0.62], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "button-row", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "button-legends", "description": "PLAY/STOP/REC/BT/ARP/SC-CH/KNOB-B/PAD-B legends, BT light-blue"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_transport_row_8.add(mesh_transport_row_8);
  meshes["transport-row"] = mesh_transport_row_8;
  colliders["transport-row"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_transport_row_8);

  const endpoint_display_module_9 = makeAttachmentEndpoint(null);
  const node_display_module_9 = new THREE.Group();
  node_display_module_9.name = "LCD display module__pivot";
  node_display_module_9.scale.set(1, 1, 1);
  if (endpoint_display_module_9) {
    node_display_module_9.position.copy(endpoint_display_module_9.start);
    node_display_module_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_display_module_9.position.set(-1.15, 0.04, -0.62);
    node_display_module_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_display_module_9.userData.sculptComponent = {"id": "display-module", "name": "LCD display module", "level": "meso", "role": "display", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Module is a recessed bezel + glass cover + emissive 7-seg plane.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "display-seat", "localStart": [-1.35, 0, -0.6], "localEnd": [-0.95, 0, -0.6], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.42, "height": 0.05, "depth": 0.2, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.15, 0.04, -0.62], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "display", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lcd-glass", "materialLayers": ["lcd-glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lcd-glass", "description": "Recessed window, Pr1 glyph in blue-white on black"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(8,12,16,1.0)", "secondaryAlbedo": "rgba(150,200,255,1.0)", "materialClass": "glass", "materialClassConfidence": 0.85}};
  node_display_module_9.userData.actionProfile = {"animationRole": "display", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_display_module_9);
  nodes["display-module"] = node_display_module_9;
  const mesh_display_module_9Geometry = endpoint_display_module_9
    ? new THREE.CylinderGeometry(endpoint_display_module_9.endRadius, endpoint_display_module_9.baseRadius, endpoint_display_module_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_display_module_9) {
    mesh_display_module_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_display_module_9 = new THREE.Mesh(
    mesh_display_module_9Geometry,
    materialMap["lcd-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_display_module_9.name = "LCD display module";
  if (endpoint_display_module_9) {
    mesh_display_module_9.position.copy(endpoint_display_module_9.midpoint);
    mesh_display_module_9.quaternion.copy(endpoint_display_module_9.quaternion);
  }
  mesh_display_module_9.castShadow = options.castShadow ?? true;
  mesh_display_module_9.receiveShadow = options.receiveShadow ?? true;
  mesh_display_module_9.userData.sculptComponent = {"id": "display-module", "name": "LCD display module", "level": "meso", "role": "display", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Module is a recessed bezel + glass cover + emissive 7-seg plane.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "display-seat", "localStart": [-1.35, 0, -0.6], "localEnd": [-0.95, 0, -0.6], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.42, "height": 0.05, "depth": 0.2, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.15, 0.04, -0.62], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "display", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lcd-glass", "materialLayers": ["lcd-glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lcd-glass", "description": "Recessed window, Pr1 glyph in blue-white on black"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(8,12,16,1.0)", "secondaryAlbedo": "rgba(150,200,255,1.0)", "materialClass": "glass", "materialClassConfidence": 0.85}};
  node_display_module_9.add(mesh_display_module_9);
  meshes["display-module"] = mesh_display_module_9;
  colliders["display-module"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_display_module_9);

  const endpoint_strip_module_10 = makeAttachmentEndpoint(null);
  const node_strip_module_10 = new THREE.Group();
  node_strip_module_10.name = "PITCH/MOD strips + OCT buttons__pivot";
  node_strip_module_10.scale.set(1, 1, 1);
  if (endpoint_strip_module_10) {
    node_strip_module_10.position.copy(endpoint_strip_module_10.start);
    node_strip_module_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_strip_module_10.position.set(-1.32, 0.03, -0.25);
    node_strip_module_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_strip_module_10.userData.sculptComponent = {"id": "strip-module", "name": "PITCH/MOD strips + OCT buttons", "level": "meso", "role": "control-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Module is 2 recessed capacitive slots + 2 OCT buttons far-left.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "strip-seat", "localStart": [-1.5, 0, 0], "localEnd": [-1.1, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.45, "height": 0.04, "depth": 0.9, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.32, 0.03, -0.25], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "control-strip", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strip-recess", "description": "Shallow recessed slots with satin inlay"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_strip_module_10.userData.actionProfile = {"animationRole": "control-strip", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_strip_module_10);
  nodes["strip-module"] = node_strip_module_10;
  const mesh_strip_module_10Geometry = endpoint_strip_module_10
    ? new THREE.CylinderGeometry(endpoint_strip_module_10.endRadius, endpoint_strip_module_10.baseRadius, endpoint_strip_module_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_strip_module_10) {
    mesh_strip_module_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_strip_module_10 = new THREE.Mesh(
    mesh_strip_module_10Geometry,
    materialMap["button-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_strip_module_10.name = "PITCH/MOD strips + OCT buttons";
  if (endpoint_strip_module_10) {
    mesh_strip_module_10.position.copy(endpoint_strip_module_10.midpoint);
    mesh_strip_module_10.quaternion.copy(endpoint_strip_module_10.quaternion);
  }
  mesh_strip_module_10.castShadow = options.castShadow ?? true;
  mesh_strip_module_10.receiveShadow = options.receiveShadow ?? true;
  mesh_strip_module_10.userData.sculptComponent = {"id": "strip-module", "name": "PITCH/MOD strips + OCT buttons", "level": "meso", "role": "control-strip", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Module is 2 recessed capacitive slots + 2 OCT buttons far-left.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "strip-seat", "localStart": [-1.5, 0, 0], "localEnd": [-1.1, 0, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.45, "height": 0.04, "depth": 0.9, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.32, 0.03, -0.25], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "control-strip", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strip-recess", "description": "Shallow recessed slots with satin inlay"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_strip_module_10.add(mesh_strip_module_10);
  meshes["strip-module"] = mesh_strip_module_10;
  colliders["strip-module"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_strip_module_10);

  const endpoint_rear_io_module_11 = makeAttachmentEndpoint(null);
  const node_rear_io_module_11 = new THREE.Group();
  node_rear_io_module_11.name = "Rear IO cluster__pivot";
  node_rear_io_module_11.scale.set(1, 1, 1);
  if (endpoint_rear_io_module_11) {
    node_rear_io_module_11.position.copy(endpoint_rear_io_module_11.start);
    node_rear_io_module_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rear_io_module_11.position.set(0.8, -0.05, -0.9);
    node_rear_io_module_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_rear_io_module_11.userData.sculptComponent = {"id": "rear-io-module", "name": "Rear IO cluster", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear face cluster: switch + LED + USB-B + sustain + print.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "chassis-body", "attachment": {"parentId": "chassis-body", "parentSocket": "rear-seat", "localStart": [0.3, -0.05, -0.9], "localEnd": [1.3, -0.05, -0.9], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.12, "depth": 0.04, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.8, -0.05, -0.9], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "io-cluster", "description": "Power switch, LED, USB-B bore, sustain bore, SMK-25 print"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_io_module_11.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["chassis-body"] ?? root).add(node_rear_io_module_11);
  nodes["rear-io-module"] = node_rear_io_module_11;
  const mesh_rear_io_module_11Geometry = endpoint_rear_io_module_11
    ? new THREE.CylinderGeometry(endpoint_rear_io_module_11.endRadius, endpoint_rear_io_module_11.baseRadius, endpoint_rear_io_module_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rear_io_module_11) {
    mesh_rear_io_module_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rear_io_module_11 = new THREE.Mesh(
    mesh_rear_io_module_11Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_io_module_11.name = "Rear IO cluster";
  if (endpoint_rear_io_module_11) {
    mesh_rear_io_module_11.position.copy(endpoint_rear_io_module_11.midpoint);
    mesh_rear_io_module_11.quaternion.copy(endpoint_rear_io_module_11.quaternion);
  }
  mesh_rear_io_module_11.castShadow = options.castShadow ?? true;
  mesh_rear_io_module_11.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_io_module_11.userData.sculptComponent = {"id": "rear-io-module", "name": "Rear IO cluster", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear face cluster: switch + LED + USB-B + sustain + print.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "chassis-body", "attachment": {"parentId": "chassis-body", "parentSocket": "rear-seat", "localStart": [0.3, -0.05, -0.9], "localEnd": [1.3, -0.05, -0.9], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.12, "depth": 0.04, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.8, -0.05, -0.9], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "io-cluster", "description": "Power switch, LED, USB-B bore, sustain bore, SMK-25 print"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_rear_io_module_11.add(mesh_rear_io_module_11);
  meshes["rear-io-module"] = mesh_rear_io_module_11;
  colliders["rear-io-module"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_rear_io_module_11);

  const endpoint_top_plate_graphics_12 = makeAttachmentEndpoint(null);
  const node_top_plate_graphics_12 = new THREE.Group();
  node_top_plate_graphics_12.name = "Silkscreen + logo layer__pivot";
  node_top_plate_graphics_12.scale.set(1, 1, 1);
  if (endpoint_top_plate_graphics_12) {
    node_top_plate_graphics_12.position.copy(endpoint_top_plate_graphics_12.start);
    node_top_plate_graphics_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_top_plate_graphics_12.position.set(0.0, 0.065, -0.3);
    node_top_plate_graphics_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_top_plate_graphics_12.userData.sculptComponent = {"id": "top-plate-graphics", "name": "Silkscreen + logo layer", "level": "meso", "role": "label", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Graphics are thin decal planes 0.001 above deck (geometry, not texture-only, for explode).", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "graphics-seat", "localStart": [-1.4, 0.03, 0], "localEnd": [1.4, 0.03, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.9, "height": 0.005, "depth": 0.95, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.065, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "label", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "silkscreen", "description": "Pad numbers, knob rings, key functions, M-VAVE logo"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_top_plate_graphics_12.userData.actionProfile = {"animationRole": "label", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["control-panel"] ?? root).add(node_top_plate_graphics_12);
  nodes["top-plate-graphics"] = node_top_plate_graphics_12;
  const mesh_top_plate_graphics_12Geometry = endpoint_top_plate_graphics_12
    ? new THREE.CylinderGeometry(endpoint_top_plate_graphics_12.endRadius, endpoint_top_plate_graphics_12.baseRadius, endpoint_top_plate_graphics_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_top_plate_graphics_12) {
    mesh_top_plate_graphics_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_top_plate_graphics_12 = new THREE.Mesh(
    mesh_top_plate_graphics_12Geometry,
    materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_top_plate_graphics_12.name = "Silkscreen + logo layer";
  if (endpoint_top_plate_graphics_12) {
    mesh_top_plate_graphics_12.position.copy(endpoint_top_plate_graphics_12.midpoint);
    mesh_top_plate_graphics_12.quaternion.copy(endpoint_top_plate_graphics_12.quaternion);
  }
  mesh_top_plate_graphics_12.castShadow = options.castShadow ?? true;
  mesh_top_plate_graphics_12.receiveShadow = options.receiveShadow ?? true;
  mesh_top_plate_graphics_12.userData.sculptComponent = {"id": "top-plate-graphics", "name": "Silkscreen + logo layer", "level": "meso", "role": "label", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Graphics are thin decal planes 0.001 above deck (geometry, not texture-only, for explode).", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "control-panel", "attachment": {"parentId": "control-panel", "parentSocket": "graphics-seat", "localStart": [-1.4, 0.03, 0], "localEnd": [1.4, 0.03, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.9, "height": 0.005, "depth": 0.95, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.065, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "label", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "body-abs", "materialLayers": ["body-abs"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "silkscreen", "description": "Pad numbers, knob rings, key functions, M-VAVE logo"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_top_plate_graphics_12.add(mesh_top_plate_graphics_12);
  meshes["top-plate-graphics"] = mesh_top_plate_graphics_12;
  colliders["top-plate-graphics"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_top_plate_graphics_12);

  const endpoint_white_key_single_13 = makeAttachmentEndpoint(null);
  const node_white_key_single_13 = new THREE.Group();
  node_white_key_single_13.name = "White key (single, x15)__pivot";
  node_white_key_single_13.scale.set(1, 1, 1);
  if (endpoint_white_key_single_13) {
    node_white_key_single_13.position.copy(endpoint_white_key_single_13.start);
    node_white_key_single_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_white_key_single_13.position.set(0.0, 0.0, 0.0);
    node_white_key_single_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_white_key_single_13.userData.sculptComponent = {"id": "white-key-single", "name": "White key (single, x15)", "level": "micro", "role": "key", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single key is a stepped cuboid with front lip + sidewalls; pivots at rear socket.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "white-key-row", "attachment": {"parentId": "white-key-row", "parentSocket": "key-socket", "localStart": [0, 0, -0.3], "localEnd": [0, 0, 0.3], "contactType": "socket", "embedDepth": 0.04, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.09, "depth": 0.68, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-white", "materialLayers": ["key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "sidewall", "description": "Sidewalls with mold witness + slot AO"}, {"id": "front-lip", "description": "Front lip overhang 6mm"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_white_key_single_13.userData.actionProfile = {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["white-key-row"] ?? root).add(node_white_key_single_13);
  nodes["white-key-single"] = node_white_key_single_13;
  const mesh_white_key_single_13Geometry = endpoint_white_key_single_13
    ? new THREE.CylinderGeometry(endpoint_white_key_single_13.endRadius, endpoint_white_key_single_13.baseRadius, endpoint_white_key_single_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_white_key_single_13) {
    mesh_white_key_single_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_white_key_single_13 = new THREE.Mesh(
    mesh_white_key_single_13Geometry,
    materialMap["key-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_white_key_single_13.name = "White key (single, x15)";
  if (endpoint_white_key_single_13) {
    mesh_white_key_single_13.position.copy(endpoint_white_key_single_13.midpoint);
    mesh_white_key_single_13.quaternion.copy(endpoint_white_key_single_13.quaternion);
  }
  mesh_white_key_single_13.castShadow = options.castShadow ?? true;
  mesh_white_key_single_13.receiveShadow = options.receiveShadow ?? true;
  mesh_white_key_single_13.userData.sculptComponent = {"id": "white-key-single", "name": "White key (single, x15)", "level": "micro", "role": "key", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single key is a stepped cuboid with front lip + sidewalls; pivots at rear socket.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "white-key-row", "attachment": {"parentId": "white-key-row", "parentSocket": "key-socket", "localStart": [0, 0, -0.3], "localEnd": [0, 0, 0.3], "contactType": "socket", "embedDepth": 0.04, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.18, "height": 0.09, "depth": 0.68, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-white", "materialLayers": ["key-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "sidewall", "description": "Sidewalls with mold witness + slot AO"}, {"id": "front-lip", "description": "Front lip overhang 6mm"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_white_key_single_13.add(mesh_white_key_single_13);
  meshes["white-key-single"] = mesh_white_key_single_13;
  colliders["white-key-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_white_key_single_13);

  const endpoint_black_key_single_14 = makeAttachmentEndpoint(null);
  const node_black_key_single_14 = new THREE.Group();
  node_black_key_single_14.name = "Black key (single, x10)__pivot";
  node_black_key_single_14.scale.set(1, 1, 1);
  if (endpoint_black_key_single_14) {
    node_black_key_single_14.position.copy(endpoint_black_key_single_14.start);
    node_black_key_single_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_black_key_single_14.position.set(0.0, 0.0, 0.0);
    node_black_key_single_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_black_key_single_14.userData.sculptComponent = {"id": "black-key-single", "name": "Black key (single, x10)", "level": "micro", "role": "key", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single black key is an elevated chamfered cuboid; pivots at rear.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "black-key-row", "attachment": {"parentId": "black-key-row", "parentSocket": "key-socket", "localStart": [0, 0, -0.15], "localEnd": [0, 0, 0.15], "contactType": "socket", "embedDepth": 0.04, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.11, "height": 0.12, "depth": 0.4, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-black", "materialLayers": ["key-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "top-gloss", "description": "Top gloss highlight + front chamfer"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17,20,23,1.0)", "secondaryAlbedo": "rgba(45,50,56,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_black_key_single_14.userData.actionProfile = {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["black-key-row"] ?? root).add(node_black_key_single_14);
  nodes["black-key-single"] = node_black_key_single_14;
  const mesh_black_key_single_14Geometry = endpoint_black_key_single_14
    ? new THREE.CylinderGeometry(endpoint_black_key_single_14.endRadius, endpoint_black_key_single_14.baseRadius, endpoint_black_key_single_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_black_key_single_14) {
    mesh_black_key_single_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_black_key_single_14 = new THREE.Mesh(
    mesh_black_key_single_14Geometry,
    materialMap["key-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_key_single_14.name = "Black key (single, x10)";
  if (endpoint_black_key_single_14) {
    mesh_black_key_single_14.position.copy(endpoint_black_key_single_14.midpoint);
    mesh_black_key_single_14.quaternion.copy(endpoint_black_key_single_14.quaternion);
  }
  mesh_black_key_single_14.castShadow = options.castShadow ?? true;
  mesh_black_key_single_14.receiveShadow = options.receiveShadow ?? true;
  mesh_black_key_single_14.userData.sculptComponent = {"id": "black-key-single", "name": "Black key (single, x10)", "level": "micro", "role": "key", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single black key is an elevated chamfered cuboid; pivots at rear.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "black-key-row", "attachment": {"parentId": "black-key-row", "parentSocket": "key-socket", "localStart": [0, 0, -0.15], "localEnd": [0, 0, 0.15], "contactType": "socket", "embedDepth": 0.04, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.11, "height": 0.12, "depth": 0.4, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "key", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "key-black", "materialLayers": ["key-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "top-gloss", "description": "Top gloss highlight + front chamfer"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17,20,23,1.0)", "secondaryAlbedo": "rgba(45,50,56,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_black_key_single_14.add(mesh_black_key_single_14);
  meshes["black-key-single"] = mesh_black_key_single_14;
  colliders["black-key-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_black_key_single_14);

  const endpoint_pad_single_15 = makeAttachmentEndpoint(null);
  const node_pad_single_15 = new THREE.Group();
  node_pad_single_15.name = "Pad (single, x8)__pivot";
  node_pad_single_15.scale.set(1, 1, 1);
  if (endpoint_pad_single_15) {
    node_pad_single_15.position.copy(endpoint_pad_single_15.start);
    node_pad_single_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pad_single_15.position.set(0.0, 0.0, 0.0);
    node_pad_single_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_pad_single_15.userData.sculptComponent = {"id": "pad-single", "name": "Pad (single, x8)", "level": "micro", "role": "pad", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single pad is a rounded-square translucent lens + emissive core disc.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pad-grid", "attachment": {"parentId": "pad-grid", "parentSocket": "pad-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.03, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.05, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pad", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pad-silicone", "materialLayers": ["pad-silicone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "emissive-core", "description": "Emissive core: cyan rows 1, lavender row 2"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160,230,230,1.0)", "secondaryAlbedo": "rgba(215,185,245,1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85}};
  node_pad_single_15.userData.actionProfile = {"animationRole": "pad", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["pad-grid"] ?? root).add(node_pad_single_15);
  nodes["pad-single"] = node_pad_single_15;
  const mesh_pad_single_15Geometry = endpoint_pad_single_15
    ? new THREE.CylinderGeometry(endpoint_pad_single_15.endRadius, endpoint_pad_single_15.baseRadius, endpoint_pad_single_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_pad_single_15) {
    mesh_pad_single_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pad_single_15 = new THREE.Mesh(
    mesh_pad_single_15Geometry,
    materialMap["pad-silicone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pad_single_15.name = "Pad (single, x8)";
  if (endpoint_pad_single_15) {
    mesh_pad_single_15.position.copy(endpoint_pad_single_15.midpoint);
    mesh_pad_single_15.quaternion.copy(endpoint_pad_single_15.quaternion);
  }
  mesh_pad_single_15.castShadow = options.castShadow ?? true;
  mesh_pad_single_15.receiveShadow = options.receiveShadow ?? true;
  mesh_pad_single_15.userData.sculptComponent = {"id": "pad-single", "name": "Pad (single, x8)", "level": "micro", "role": "pad", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single pad is a rounded-square translucent lens + emissive core disc.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pad-grid", "attachment": {"parentId": "pad-grid", "parentSocket": "pad-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.03, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.05, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pad", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pad-silicone", "materialLayers": ["pad-silicone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "emissive-core", "description": "Emissive core: cyan rows 1, lavender row 2"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(160,230,230,1.0)", "secondaryAlbedo": "rgba(215,185,245,1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85}};
  node_pad_single_15.add(mesh_pad_single_15);
  meshes["pad-single"] = mesh_pad_single_15;
  colliders["pad-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_pad_single_15);

  const attachment_knob_single_16 = {"parentId": "knob-cluster", "parentSocket": "knob-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.09, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]};
  const endpoint_knob_single_16 = makeAttachmentEndpoint(attachment_knob_single_16);
  const node_knob_single_16 = new THREE.Group();
  node_knob_single_16.name = "Knob (single, x8)__pivot";
  node_knob_single_16.scale.set(1, 1, 1);
  if (endpoint_knob_single_16) {
    node_knob_single_16.position.copy(endpoint_knob_single_16.start);
    node_knob_single_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_knob_single_16.position.set(0.0, 0.0, 0.0);
    node_knob_single_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_knob_single_16.userData.sculptComponent = {"id": "knob-single", "name": "Knob (single, x8)", "level": "micro", "role": "knob", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Single knob is a fluted octagonal cylinder + pointer line + skirt.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "knob-cluster", "attachment": {"parentId": "knob-cluster", "parentSocket": "knob-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.09, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.14, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "knob", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pointer", "description": "White indicator line + legend ring"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_knob_single_16.userData.actionProfile = {"animationRole": "knob", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["knob-cluster"] ?? root).add(node_knob_single_16);
  nodes["knob-single"] = node_knob_single_16;
  const mesh_knob_single_16Geometry = endpoint_knob_single_16
    ? new THREE.CylinderGeometry(endpoint_knob_single_16.endRadius, endpoint_knob_single_16.baseRadius, endpoint_knob_single_16.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_knob_single_16) {
    mesh_knob_single_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_knob_single_16 = new THREE.Mesh(
    mesh_knob_single_16Geometry,
    materialMap["knob-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_knob_single_16.name = "Knob (single, x8)";
  if (endpoint_knob_single_16) {
    mesh_knob_single_16.position.copy(endpoint_knob_single_16.midpoint);
    mesh_knob_single_16.quaternion.copy(endpoint_knob_single_16.quaternion);
  }
  mesh_knob_single_16.castShadow = options.castShadow ?? true;
  mesh_knob_single_16.receiveShadow = options.receiveShadow ?? true;
  mesh_knob_single_16.userData.sculptComponent = {"id": "knob-single", "name": "Knob (single, x8)", "level": "micro", "role": "knob", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Single knob is a fluted octagonal cylinder + pointer line + skirt.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "knob-cluster", "attachment": {"parentId": "knob-cluster", "parentSocket": "knob-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.09, 0], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.14, "height": 0.11, "depth": 0.14, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "knob", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pointer", "description": "White indicator line + legend ring"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_knob_single_16.add(mesh_knob_single_16);
  meshes["knob-single"] = mesh_knob_single_16;
  colliders["knob-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_knob_single_16);

  const endpoint_button_single_17 = makeAttachmentEndpoint(null);
  const node_button_single_17 = new THREE.Group();
  node_button_single_17.name = "Transport button (single, x8)__pivot";
  node_button_single_17.scale.set(1, 1, 1);
  if (endpoint_button_single_17) {
    node_button_single_17.position.copy(endpoint_button_single_17.start);
    node_button_single_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_button_single_17.position.set(0.0, 0.0, 0.0);
    node_button_single_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_button_single_17.userData.sculptComponent = {"id": "button-single", "name": "Transport button (single, x8)", "level": "micro", "role": "button", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single button is a rounded-rect cap with legend decal; vertical press travel.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "transport-row", "attachment": {"parentId": "transport-row", "parentSocket": "button-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.025, 0], "contactType": "socket", "embedDepth": 0.025, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.03, "depth": 0.11, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "legend", "description": "Legend decal plane 0.001 above cap"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_button_single_17.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["transport-row"] ?? root).add(node_button_single_17);
  nodes["button-single"] = node_button_single_17;
  const mesh_button_single_17Geometry = endpoint_button_single_17
    ? new THREE.CylinderGeometry(endpoint_button_single_17.endRadius, endpoint_button_single_17.baseRadius, endpoint_button_single_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_button_single_17) {
    mesh_button_single_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_button_single_17 = new THREE.Mesh(
    mesh_button_single_17Geometry,
    materialMap["button-gray"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_button_single_17.name = "Transport button (single, x8)";
  if (endpoint_button_single_17) {
    mesh_button_single_17.position.copy(endpoint_button_single_17.midpoint);
    mesh_button_single_17.quaternion.copy(endpoint_button_single_17.quaternion);
  }
  mesh_button_single_17.castShadow = options.castShadow ?? true;
  mesh_button_single_17.receiveShadow = options.receiveShadow ?? true;
  mesh_button_single_17.userData.sculptComponent = {"id": "button-single", "name": "Transport button (single, x8)", "level": "micro", "role": "button", "importance": 0.8, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Single button is a rounded-rect cap with legend decal; vertical press travel.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "transport-row", "attachment": {"parentId": "transport-row", "parentSocket": "button-socket", "localStart": [0, 0, 0], "localEnd": [0, 0.025, 0], "contactType": "socket", "embedDepth": 0.025, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.03, "depth": 0.11, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "button-gray", "materialLayers": ["button-gray"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "legend", "description": "Legend decal plane 0.001 above cap"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242,243,244,1.0)", "secondaryAlbedo": "rgba(210,214,218,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9}};
  node_button_single_17.add(mesh_button_single_17);
  meshes["button-single"] = mesh_button_single_17;
  colliders["button-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_button_single_17);

  const attachment_io_socket_single_18 = {"parentId": "rear-io-module", "parentSocket": "io-seat", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.03], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]};
  const endpoint_io_socket_single_18 = makeAttachmentEndpoint(attachment_io_socket_single_18);
  const node_io_socket_single_18 = new THREE.Group();
  node_io_socket_single_18.name = "Rear socket (single)__pivot";
  node_io_socket_single_18.scale.set(1, 1, 1);
  if (endpoint_io_socket_single_18) {
    node_io_socket_single_18.position.copy(endpoint_io_socket_single_18.start);
    node_io_socket_single_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_io_socket_single_18.position.set(0.0, 0.0, 0.0);
    node_io_socket_single_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_io_socket_single_18.userData.sculptComponent = {"id": "io-socket-single", "name": "Rear socket (single)", "level": "micro", "role": "connector", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Single bore is a recessed cylinder shell + inner contact disc.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rear-io-module", "attachment": {"parentId": "rear-io-module", "parentSocket": "io-seat", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.03], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.09, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "bore", "description": "USB-B rectangular bore / sustain circular bore"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_io_socket_single_18.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rear-io-module"] ?? root).add(node_io_socket_single_18);
  nodes["io-socket-single"] = node_io_socket_single_18;
  const mesh_io_socket_single_18Geometry = endpoint_io_socket_single_18
    ? new THREE.CylinderGeometry(endpoint_io_socket_single_18.endRadius, endpoint_io_socket_single_18.baseRadius, endpoint_io_socket_single_18.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_io_socket_single_18) {
    mesh_io_socket_single_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_io_socket_single_18 = new THREE.Mesh(
    mesh_io_socket_single_18Geometry,
    materialMap["knob-black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_io_socket_single_18.name = "Rear socket (single)";
  if (endpoint_io_socket_single_18) {
    mesh_io_socket_single_18.position.copy(endpoint_io_socket_single_18.midpoint);
    mesh_io_socket_single_18.quaternion.copy(endpoint_io_socket_single_18.quaternion);
  }
  mesh_io_socket_single_18.castShadow = options.castShadow ?? true;
  mesh_io_socket_single_18.receiveShadow = options.receiveShadow ?? true;
  mesh_io_socket_single_18.userData.sculptComponent = {"id": "io-socket-single", "name": "Rear socket (single)", "level": "micro", "role": "connector", "importance": 0.8, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Single bore is a recessed cylinder shell + inner contact disc.", "geometryDescriptor": {"topologyIntent": "hard-surface procedural solid with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rear-io-module", "attachment": {"parentId": "rear-io-module", "parentSocket": "io-seat", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.03], "contactType": "socket", "embedDepth": 0.03, "gapTolerance": 0.004, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.09, "height": 0.09, "depth": 0.05, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "smk25-assembly", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "knob-black", "materialLayers": ["knob-black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "bore", "description": "USB-B rectangular bore / sustain circular bore"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.3, "bumpAmplitude": 0.06, "normalPattern": "procedural grain", "displacementPattern": "", "occlusionPattern": "recess AO", "edgeWearPattern": "edge highlight", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30,32,36,1.0)", "secondaryAlbedo": "rgba(60,64,70,1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85}};
  node_io_socket_single_18.add(mesh_io_socket_single_18);
  meshes["io-socket-single"] = mesh_io_socket_single_18;
  colliders["io-socket-single"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Simplified proxy for runtime physics."};
  destructionGroups["smk25-assembly"] ??= [];
  destructionGroups["smk25-assembly"].push(node_io_socket_single_18);

  // repetition system: white-key-system (InstancedMesh, radial, count=15, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 15);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 15; i++) {
      const ang = ((0.0) + (i * 360) / 15) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "white-key-system";
    parent.add(cluster);
  }

  // repetition system: black-key-system (InstancedMesh, radial, count=10, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 10);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 10; i++) {
      const ang = ((0.0) + (i * 360) / 10) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "black-key-system";
    parent.add(cluster);
  }

  // repetition system: pad-system (InstancedMesh, radial, count=8, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 8);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 8; i++) {
      const ang = ((0.0) + (i * 360) / 8) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "pad-system";
    parent.add(cluster);
  }

  // repetition system: knob-system (InstancedMesh, radial, count=8, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["body-abs"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 8);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 8; i++) {
      const ang = ((0.0) + (i * 360) / 8) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "knob-system";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createMVAVESMK25MIDIKeyboardLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "M-VAVE SMK-25 MIDI Keyboard look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["key light: upper-left softbox, white 2.0, casts soft shadow lower-right; exposure 1.0 with ACESFilmicToneMapping", "fill light: right-side diffused fill, neutral 0.55, lifts keybed slots without flattening white ABS tone mapping ACES", "rim/environment light: RoomEnvironment PMREM 0.5 + rear rim to separate black keys/knobs from white deck", "background #F2F2F2 studio sweep with contact shadow: soft radial AO under chassis + key slot cavities, shadow softness 10px"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createMVAVESMK25MIDIKeyboardEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameMVAVESMK25MIDIKeyboardCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createMVAVESMK25MIDIKeyboardPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureMVAVESMK25MIDIKeyboardRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createMVAVESMK25MIDIKeyboardInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
