export interface EmbeddedWebAsset {
  contentType: string;
  contentBase64: string;
}

export type EmbeddedWebAssets = Record<string, EmbeddedWebAsset>;

let embeddedWebAssets: EmbeddedWebAssets = {};

export function setEmbeddedWebAssets(assets: EmbeddedWebAssets): void {
  embeddedWebAssets = assets;
}

export function getEmbeddedWebAssets(): EmbeddedWebAssets {
  return embeddedWebAssets;
}
