import { beforeEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  initWasm: vi.fn(),
  create: vi.fn(),
  render: vi.fn(),
  asPng: vi.fn(),
  freeImage: vi.fn(),
  freeRenderer: vi.fn(),
}));

vi.mock("@resvg/resvg-wasm", () => ({
  initWasm: mocked.initWasm,
  Resvg: class {
    constructor(svg: string, options: unknown) { mocked.create(svg, options); }
    render() { return mocked.render(); }
    free() { mocked.freeRenderer(); }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocked.initWasm.mockResolvedValue(undefined);
  mocked.asPng.mockReturnValue(new Uint8Array([1, 2, 3]));
  mocked.render.mockImplementation(() => ({ asPng: mocked.asPng, free: mocked.freeImage }));
});

it("loads assets lazily and shares WASM initialization across concurrent renderers", async () => {
  const { createResvgRenderer } = await import("../src/rendering/resvg.ts");
  const assets = { wasm: new Uint8Array([0]), fonts: [new Uint8Array([1])] };
  const load = vi.fn(async () => assets);
  const render = createResvgRenderer(load);
  expect(load).not.toHaveBeenCalled();
  await Promise.all([render("<svg/>", 480), render("<svg/>", 480)]);
  await createResvgRenderer(async () => assets)("<svg/>");
  expect(load).toHaveBeenCalledTimes(1);
  expect(mocked.initWasm).toHaveBeenCalledTimes(1);
  expect(mocked.create).toHaveBeenCalledWith("<svg/>", expect.objectContaining({
    fitTo: { mode: "width", value: 480 },
    font: expect.objectContaining({ fontBuffers: assets.fonts, loadSystemFonts: false }),
  }));
  expect(mocked.freeRenderer).toHaveBeenCalledTimes(3);
  expect(mocked.freeImage).toHaveBeenCalledTimes(3);
});

it("frees the renderer when rendering throws", async () => {
  const { createResvgRenderer } = await import("../src/rendering/resvg.ts");
  mocked.render.mockImplementation(() => { throw new Error("render failed"); });
  const render = createResvgRenderer(async () => ({ wasm: new Uint8Array(), fonts: [] }));
  await expect(render("<svg/>")).rejects.toThrow("render failed");
  expect(mocked.freeRenderer).toHaveBeenCalledTimes(1);
  expect(mocked.freeImage).not.toHaveBeenCalled();
});

it("frees the image and renderer when PNG encoding throws", async () => {
  const { createResvgRenderer } = await import("../src/rendering/resvg.ts");
  mocked.asPng.mockImplementation(() => { throw new Error("PNG failed"); });
  const render = createResvgRenderer(async () => ({ wasm: new Uint8Array(), fonts: [] }));
  await expect(render("<svg/>")).rejects.toThrow("PNG failed");
  expect(mocked.freeRenderer).toHaveBeenCalledTimes(1);
  expect(mocked.freeImage).toHaveBeenCalledTimes(1);
});

it("retries asset loading and WASM initialization after failures", async () => {
  const { createResvgRenderer } = await import("../src/rendering/resvg.ts");
  const load = vi.fn(async () => ({ wasm: new Uint8Array(), fonts: [] }))
    .mockRejectedValueOnce(new Error("assets unavailable"));
  mocked.initWasm.mockRejectedValueOnce(new Error("init failed"));
  const render = createResvgRenderer(load);
  await expect(render("<svg/>")).rejects.toThrow("assets unavailable");
  await expect(render("<svg/>")).rejects.toThrow("init failed");
  expect(await render("<svg/>")).toEqual(new Uint8Array([1, 2, 3]));
  expect(load).toHaveBeenCalledTimes(3);
  expect(mocked.initWasm).toHaveBeenCalledTimes(2);
});
