/**
 * Type shims for echarts' deep `install.js` modules (see components/EChart.tsx).
 *
 * echarts 6 publishes its public types under `types/dist/*.d.ts` and only maps
 * the barrel entries (`./core`, `./charts`, …) to them, so TypeScript cannot
 * resolve the per-feature `lib/**\/install.js` files that the on-demand build
 * imports. The runtime modules each export a single `install(registers)`
 * function; typing the parameter as `unknown` keeps it assignable to
 * `EChartsExtensionInstaller` (parameter contravariance) while the actual
 * registration safety comes from echarts' own `use` lookup at runtime.
 */
declare module "echarts/lib/chart/bar/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/chart/pie/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/component/grid/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/component/tooltip/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/component/axisPointer/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/component/legend/install" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/renderer/installCanvasRenderer" {
  const install: (registers: unknown) => void;
  export { install };
}
declare module "echarts/lib/renderer/installSVGRenderer" {
  const install: (registers: unknown) => void;
  export { install };
}
