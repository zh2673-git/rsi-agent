export interface RenderSpec {
  width: number;
  height: number;
  fps: number;
  codec: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RenderBackend {
  readonly name: string;
  doctor(): Promise<Check[]>;
  render(projectDir: string, spec: RenderSpec, outFile: string): Promise<string>;
  validateOutput?(outFile: string, expectedMs: number): Promise<Check[]>;
}
