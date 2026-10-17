import { DracoCompression } from "@babylonjs/core/Meshes/Compression/dracoCompression";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";

let configured = false;

/**
 * 将 Babylon 运行时解码器指向本地 public/vendor 副本（由
 * tools/pipeline/vendor-decoders.mjs 生成），避免依赖 CDN。
 */
export function configureRuntimeDecoders(): void {
  if (configured) {
    return;
  }
  configured = true;

  DracoCompression.Configuration = {
    decoder: {
      wasmUrl: "/vendor/draco/draco_wasm_wrapper_gltf.js",
      wasmBinaryUrl: "/vendor/draco/draco_decoder_gltf.wasm",
      fallbackUrl: "/vendor/draco/draco_decoder_gltf.js",
    },
  };

  MeshoptCompression.Configuration = {
    decoder: {
      url: "/vendor/meshopt/meshopt_decoder.js",
    },
  };

  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: "/vendor/ktx2/babylon.ktx2Decoder.js",
    wasmUASTCToASTC: "/vendor/ktx2/uastc_astc.wasm",
    wasmUASTCToBC7: "/vendor/ktx2/uastc_bc7.wasm",
    wasmUASTCToRGBA_UNORM: "/vendor/ktx2/uastc_rgba8_unorm_v2.wasm",
    wasmUASTCToRGBA_SRGB: "/vendor/ktx2/uastc_rgba8_srgb_v2.wasm",
    wasmUASTCToR8_UNORM: "/vendor/ktx2/uastc_r8_unorm.wasm",
    wasmUASTCToRG8_UNORM: "/vendor/ktx2/uastc_rg8_unorm.wasm",
    jsMSCTranscoder: "/vendor/ktx2/msc_basis_transcoder.js",
    wasmMSCTranscoder: "/vendor/ktx2/msc_basis_transcoder.wasm",
    wasmZSTDDecoder: "/vendor/ktx2/zstddec.wasm",
  };
}
