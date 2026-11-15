// Types du lecteur de crate de three.js (examples/jsm, sans déclarations fournies) : seulement ce
// que src/usd/usdc.ts utilise ou surcharge.

declare module 'three/examples/jsm/loaders/usd/USDCParser.js' {
  export interface CrateValueRep {
    readonly isArray: boolean;
    readonly isInlined: boolean;
    readonly isCompressed: boolean;
    readonly typeEnum: number;
    readonly payload: number;
    getInlinedValue(): number;
  }

  export interface CrateReader {
    seek(offset: number): void;
    tell(): number;
    readUint8(): number;
    readInt8(): number;
    readUint16(): number;
    readInt32(): number;
    readUint32(): number;
    readInt64(): number;
    readUint64(): number;
    readFloat32(): number;
    readFloat64(): number;
  }

  export interface CrateSpec {
    pathIndex: number;
    fieldSetIndex: number;
    specType: number;
  }

  export class USDCParser {
    protected reader: CrateReader;
    protected version: { major: number; minor: number; patch: number };
    protected tokens: string[];
    protected strings: number[];
    protected paths: string[];
    protected fields: { tokenIndex: number; valueRep: CrateValueRep }[];
    parseData(buffer: ArrayBuffer): { specsByPath: Record<string, { specType: number; fields: Record<string, unknown> }> };
    protected _readValue(valueRep: CrateValueRep): unknown;
    protected _readInlinedValue(valueRep: CrateValueRep): unknown;
    protected _readScalarValue(type: number): unknown;
    protected _readArrayValue(valueRep: CrateValueRep): unknown;
    protected _readCompressedArray(type: number, size: number): unknown;
    protected _readHalf(): number;
    protected _halfToFloat(h: number): number;
    protected _getFieldsForSpec(spec: CrateSpec): Record<string, unknown>;
  }
}
