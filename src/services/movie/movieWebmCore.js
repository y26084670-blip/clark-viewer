export const WEBM_QUALITY = Object.freeze({ codec: "libvpx-vp9", crf: 30, bitrate: 0 });

// Stream one RGBA frame at a time through libvpx and the WebM muxer. There is
// no frame-rate-dependent screen recording and no accumulation of raw frames.
export function createMovieWebmCore(libav, { maxBytes = 128 * 1024 * 1024 } = {}) {
  let ctx, framePtr, packetPtr, muxer, io, scaler, inputPtr, outputPtr, size, encodedBytes = 0, closed = false, time = 0, frames = 0;
  const durations = new Map();
  async function init(width, height) {
    size = { width, height };
    await libav.av_log_set_level(libav.AV_LOG_ERROR);
    [, ctx, framePtr, packetPtr] = await libav.ff_init_encoder(WEBM_QUALITY.codec, {
      ctx: { width, height, pix_fmt: libav.AV_PIX_FMT_YUV420P, bit_rate: 0, gop_size: 120 },
      time_base: [1, 1000],
      options: { crf: "30", deadline: "good", "cpu-used": "4", "lag-in-frames": "0" },
    });
    [muxer, , io] = await libav.ff_init_muxer({ filename: "movie.webm", format_name: "webm", open: true }, [[ctx, 1, 1000]]);
    await libav.avformat_write_header(muxer, 0);
    scaler = await libav.sws_getContext(width, height, libav.AV_PIX_FMT_RGBA,
      width, height, libav.AV_PIX_FMT_YUV420P, 2, 0, 0, 0);
    inputPtr = await libav.av_frame_alloc(); outputPtr = await libav.av_frame_alloc();
    if (!scaler || !inputPtr || !outputPtr) throw new Error("Не удалось подготовить преобразование цвета WebM");
  }
  async function write(packets) {
    for (const packet of packets) {
      encodedBytes += packet.data.length;
      if (encodedBytes > maxBytes) throw new Error("WebM превышает 128 МиБ");
      packet.stream_index = 0;
      // Explicit durations preserve GIF variable delays and the final frame.
      packet.duration = durations.get(libav.i64tof64(packet.pts, packet.ptshi)) ?? 0;
      packet.durationhi = 0; durations.delete(libav.i64tof64(packet.pts, packet.ptshi));
    }
    await libav.ff_write_multi(muxer, packetPtr, packets);
  }
  return {
    async addFrame(frame, { delayMs } = {}) {
      if (closed) throw new Error("Кодировщик WebM закрыт");
      const { width, height, data } = frame;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16777216
        || !data || data.length !== width * height * 4 || !Number.isInteger(delayMs) || delayMs <= 0)
        throw new Error("Некорректный кадр WebM или его длительность");
      if (!ctx) await init(width, height);
      if (size.width !== width || size.height !== height) throw new Error("Размер кадров WebM должен быть постоянным");
      // VP9 profile 0 is opaque; composite GIF transparency on white.
      for (let k = 0; k < data.length; k += 4) if (data[k + 3] !== 255) {
        const a = data[k + 3] / 255;
        for (let c = 0; c < 3; c++) data[k + c] = Math.round(data[k + c] * a + 255 * (1 - a));
        data[k + 3] = 255;
      }
      durations.set(time, delayMs);
      const [pts, ptshi] = libav.f64toi64(time);
      const input = { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), format: libav.AV_PIX_FMT_RGBA,
        width, height, layout: [{ offset: 0, stride: width * 4 }], pts, ptshi, time_base_num: 1, time_base_den: 1000 };
      await libav.ff_copyin_frame(inputPtr, input);
      await libav.av_frame_unref(outputPtr);
      await libav.AVFrame_width_s(outputPtr, width); await libav.AVFrame_height_s(outputPtr, height);
      await libav.AVFrame_format_s(outputPtr, libav.AV_PIX_FMT_YUV420P);
      const code = await libav.sws_scale_frame(scaler, outputPtr, inputPtr);
      if (code < 0) throw new Error(`Ошибка преобразования цвета WebM: ${code}`);
      const filtered = await libav.ff_copyout_frame(outputPtr);
      Object.assign(filtered, { pts, ptshi, time_base_num: 1, time_base_den: 1000 });
      await write(await libav.ff_encode_multi(ctx, framePtr, packetPtr, [filtered]));
      time += delayMs; frames++;
      return { frames, durationMs: time, ...size };
    },
    async finish() {
      if (closed || !ctx || !frames) throw new Error("Нет кадров для WebM");
      closed = true;
      await write(await libav.ff_encode_multi(ctx, framePtr, packetPtr, [], true));
      await libav.av_write_trailer(muxer);
      const bytes = await libav.readFile("movie.webm");
      if (!bytes.length || bytes.length > maxBytes) throw new Error("Недопустимый размер WebM");
      await libav.ff_free_muxer(muxer, io); await libav.ff_free_encoder(ctx, framePtr, packetPtr);
      await libav.sws_freeContext(scaler);
      await libav.av_frame_free_js(inputPtr); await libav.av_frame_free_js(outputPtr);
      await libav.unlink("movie.webm");
      return bytes;
    },
  };
}
