package io.github.imuhakim.remotetv.tv;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.WindowManager;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * "Cast phone screen" receiver on TCP 7335. A paired phone sends one JSON line
 * {"token","w","h"}, gets {"ok":true} back, then H.264 frames:
 *   int32 length, int64 ptsUs, byte flags (1 = codec config, 2 = key frame,
 *   4 = new size: payload is JSON {"w","h"}), payload.
 * Frames are decoded straight onto a full-screen overlay window. One phone at a
 * time; a new phone replaces the old one. Closing the socket ends the cast.
 */
class CastReceiver {
    static final int PORT = 7335;

    interface TokenCheck { boolean valid(String token); }

    private final Context ctx;
    private final TokenCheck check;
    private final WindowManager wm;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ServerSocket server;
    private volatile boolean running;
    private volatile Socket current;

    private FrameLayout root;
    private SurfaceView view;
    private volatile Surface surface;
    private CountDownLatch surfaceReady = new CountDownLatch(1);

    CastReceiver(Context ctx, TokenCheck check) {
        this.ctx = ctx;
        this.check = check;
        this.wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    }

    void start() {
        running = true;
        new Thread(() -> {
            try {
                server = new ServerSocket(PORT);
                while (running) {
                    Socket s = server.accept();
                    new Thread(() -> serve(s), "cast-in").start();
                }
            } catch (Exception ignored) { }
        }, "cast-server").start();
    }

    void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        try { if (current != null) current.close(); } catch (Exception ignored) { }
        ui.post(this::hide);
    }

    private static String readLine(java.io.InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1 && c != '\n') {
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 4096) throw new Exception("header too long");
        }
        return sb.toString();
    }

    private void serve(Socket sock) {
        MediaCodec codec = null;
        try (Socket s = sock) {
            s.setTcpNoDelay(true);
            s.setSoTimeout(15_000);
            BufferedInputStream bin = new BufferedInputStream(s.getInputStream(), 256 * 1024);
            OutputStream out = s.getOutputStream();
            JSONObject hello = new JSONObject(readLine(bin));
            JSONObject r = new JSONObject();
            if (!check.valid(hello.optString("token", ""))) {
                out.write((r.put("ok", false).put("error", "Not paired").toString() + "\n").getBytes(StandardCharsets.UTF_8));
                return;
            }
            if (!HelperService.canDraw(ctx)) {
                out.write((r.put("ok", false).put("error", "RemoteTV on the TV is not allowed to draw over other apps").toString() + "\n").getBytes(StandardCharsets.UTF_8));
                return;
            }
            Socket old = current;
            current = s;
            if (old != null) try { old.close(); } catch (Exception ignored) { }
            out.write((r.put("ok", true).toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();

            int w = clamp(hello.optInt("w", 720)), h = clamp(hello.optInt("h", 1280));
            Surface target = show(w, h);
            if (target == null) return;
            codec = decoder(w, h, target);

            DataInputStream in = new DataInputStream(bin);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] buf = new byte[512 * 1024];
            while (running && current == s) {
                int len = in.readInt();
                long pts = in.readLong();
                int flags = in.readUnsignedByte();
                if (len < 0 || len > 8 * 1024 * 1024) break;
                if (len > buf.length) buf = new byte[len];
                in.readFully(buf, 0, len);
                if ((flags & 4) != 0) { // the phone turned: new picture size
                    JSONObject sz = new JSONObject(new String(buf, 0, len, StandardCharsets.UTF_8));
                    w = clamp(sz.optInt("w", w)); h = clamp(sz.optInt("h", h));
                    codec.stop(); codec.release(); codec = null;
                    resize(w, h);
                    codec = decoder(w, h, surface);
                    continue;
                }
                int idx = codec.dequeueInputBuffer(50_000);
                if (idx >= 0) {
                    ByteBuffer ib = codec.getInputBuffer(idx);
                    ib.clear();
                    ib.put(buf, 0, Math.min(len, ib.capacity()));
                    codec.queueInputBuffer(idx, 0, Math.min(len, ib.capacity()), pts,
                            (flags & 1) != 0 ? MediaCodec.BUFFER_FLAG_CODEC_CONFIG : 0);
                }
                int o;
                while ((o = codec.dequeueOutputBuffer(info, 0)) >= 0 || o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (o >= 0) codec.releaseOutputBuffer(o, true);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (codec != null) try { codec.stop(); codec.release(); } catch (Exception ignored) { }
            if (current == sock) { current = null; ui.post(this::hide); }
        }
    }

    private static int clamp(int v) { return Math.max(64, Math.min(4096, v)); }

    private static MediaCodec decoder(int w, int h, Surface target) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        MediaCodec c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            c.configure(f, target, null, 0);
        } catch (Exception e) { // some TVs reject KEY_LOW_LATENCY
            c.release();
            c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            c.configure(MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h), target, null, 0);
        }
        c.start();
        return c;
    }

    /** Puts a black full-screen window with a picture area of the phone's shape; waits for its surface. */
    private Surface show(int w, int h) throws InterruptedException {
        surfaceReady = new CountDownLatch(1);
        ui.post(() -> {
            hide();
            root = new FrameLayout(ctx);
            root.setBackgroundColor(Color.BLACK);
            view = new SurfaceView(ctx);
            view.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override public void surfaceCreated(SurfaceHolder holder) { surface = holder.getSurface(); surfaceReady.countDown(); }
                @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
                @Override public void surfaceDestroyed(SurfaceHolder holder) { surface = null; }
            });
            root.addView(view, fit(w, h));
            int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.OPAQUE);
            try { wm.addView(root, lp); } catch (Exception e) { root = null; surfaceReady.countDown(); }
        });
        surfaceReady.await(5, TimeUnit.SECONDS);
        return surface;
    }

    private void resize(int w, int h) {
        CountDownLatch done = new CountDownLatch(1);
        ui.post(() -> { if (view != null) view.setLayoutParams(fit(w, h)); done.countDown(); });
        try { done.await(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
    }

    private FrameLayout.LayoutParams fit(int w, int h) {
        Point screen = new Point();
        try { wm.getDefaultDisplay().getRealSize(screen); } catch (Exception e) { screen.set(1920, 1080); }
        double k = Math.min(screen.x / (double) w, screen.y / (double) h);
        return new FrameLayout.LayoutParams((int) Math.round(w * k), (int) Math.round(h * k), Gravity.CENTER);
    }

    private void hide() {
        if (root == null) return;
        try { wm.removeView(root); } catch (Exception ignored) { }
        root = null;
        view = null;
        surface = null;
    }
}
