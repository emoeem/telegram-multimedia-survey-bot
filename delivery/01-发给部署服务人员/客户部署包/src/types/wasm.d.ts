declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module "*.ttf" {
  const fontData: ArrayBuffer;
  export default fontData;
}
