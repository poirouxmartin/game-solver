declare module 'wgsl_reflect/wgsl_reflect.module.js' {
  export class WgslParser {
    parse(tokensOrCode: string | unknown[]): unknown;
  }
}