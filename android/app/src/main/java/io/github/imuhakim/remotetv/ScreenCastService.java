package io.github.imuhakim.remotetv;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * Sends this phone's screen to RemoteTV on an Android TV (tv/CastReceiver, TCP 7335)
 * as H.264. Runs as a mediaProjection foreground service; the user approves the
 * system "start recording or casting" dialog first (RemoteTvPlugin.screenCast).
 */
public class ScreenCastService extends Service {
    public interface Listener { void onState(boolean running, String error); }

    static final String STOP = "io.github.imuhakim.remotetv.CAST_STOP";
    private static final String CHANNEL = "screencast";
    private static final int LONG_SIDE = 1280;

    static volatile Listener listener;
    static volatile boolean running;
    static volatile String target;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaCodec encoder;
    private Socket socket;
    private DataOutputStream out;
    private Thread pump;
    private int width, height;
    private volatile boolean stopping;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) { finish(null); return START_NOT_STICKY; }
        goForeground();
        int code = intent.getIntExtra("code", Activity.RESULT_CANCELED);
        Intent data = intent.getParcelableExtra("data");
        String host = intent.getStringExtra("host");
        int port = intent.getIntExtra("port", 7335);
        String token = intent.getStringExtra("token");
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        try {
            projection = mpm.getMediaProjection(code, data);
        } catch (Exception e) {
            finish("Screen capture was not allowed");
            return START_NOT_STICKY;
        }
        if (projection == null) { finish("Screen capture was not allowed"); return START_NOT_STICKY; }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { finish(null); }
        }, ui);
        target = host;
        new Thread(() -> connect(host, port, token), "cast-connect").start();
        return START_NOT_STICKY;
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen cast", NotificationManager.IMPORTANCE_LOW));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ScreenCastService.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = b.setContentTitle("Casting your screen to the TV")
                .setContentText("Tap Stop to end")
                .setSmallIcon(R.drawable.ic_helper)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(2, n);
    }

    private void connect(String host, int port, String token) {
        try {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), 5000);
            socket.setTcpNoDelay(true);
            socket.setSendBufferSize(512 * 1024);
            out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 256 * 1024));
            pickSize();
            JSONObject hello = new JSONObject().put("token", token).put("w", width).put("h", height).put("name", Build.MODEL);
            out.write((hello.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            String reply = readLine(socket.getInputStream());
            JSONObject r = new JSONObject(reply.isEmpty() ? "{}" : reply);
            if (!r.optBoolean("ok")) { finish(r.optString("error", "The TV refused the cast")); return; }
            ui.post(() -> {
                try {
                    startEncoder();
                    running = true;
                    Listener l = listener;
                    if (l != null) l.onState(true, null);
                } catch (Exception e) { finish("Cannot start the video encoder: " + e.getMessage()); }
            });
        } catch (java.net.ConnectException e) {
            finish("RemoteTV on the TV is not ready for screen cast. Update RemoteTV on the TV (More › Draw on TV › Install on the TV).");
        } catch (Exception e) {
            if (!stopping) finish("Cannot reach the TV: " + e.getMessage());
        }
    }

    private static String readLine(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1 && c != '\n') { sb.append((char) c); if (sb.length() > 4096) break; }
        return sb.toString();
    }

    /** Phone screen shape, scaled so the long side is 1280 and both sides are multiples of 16. */
    private void pickSize() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        double k = (double) LONG_SIDE / Math.max(m.widthPixels, m.heightPixels);
        width = Math.max(16, (int) Math.round(m.widthPixels * k / 16) * 16);
        height = Math.max(16, (int) Math.round(m.heightPixels * k / 16) * 16);
    }

    private void startEncoder() throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000); // keep frames coming when nothing moves
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        enc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        Surface input = enc.createInputSurface();
        enc.start();
        encoder = enc;
        int dpi = getResources().getDisplayMetrics().densityDpi;
        if (display == null) {
            display = projection.createVirtualDisplay("RemoteTV cast", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null);
        } else {
            display.resize(width, height, dpi);
            display.setSurface(input);
        }
        final MediaCodec mine = enc;
        pump = new Thread(() -> pump(mine), "cast-pump");
        pump.start();
    }

    private void pump(MediaCodec enc) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] chunk = new byte[256 * 1024];
        try {
            while (!stopping && encoder == enc) {
                int i = enc.dequeueOutputBuffer(info, 100_000);
                if (i < 0) continue;
                ByteBuffer b = enc.getOutputBuffer(i);
                if (info.size > 0 && b != null) {
                    if (info.size > chunk.length) chunk = new byte[info.size];
                    b.position(info.offset);
                    b.get(chunk, 0, info.size);
                    int fl = ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0 ? 1 : 0)
                            | ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0 ? 2 : 0);
                    send(chunk, info.size, info.presentationTimeUs, fl);
                }
                enc.releaseOutputBuffer(i, false);
            }
        } catch (IllegalStateException e) {
            // encoder replaced after the phone turned
        } catch (Exception e) {
            if (!stopping) finish("The TV stopped the cast");
        }
    }

    private synchronized void send(byte[] data, int len, long pts, int flags) throws Exception {
        out.writeInt(len);
        out.writeLong(pts);
        out.writeByte(flags);
        out.write(data, 0, len);
        out.flush();
    }

    /** The phone turned: tell the TV the new shape and restart the encoder at that size. */
    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (!running || encoder == null) return;
        int ow = width, oh = height;
        pickSize();
        if (ow == width && oh == height) return;
        MediaCodec old = encoder;
        encoder = null;
        try { old.stop(); } catch (Exception ignored) { }
        try { old.release(); } catch (Exception ignored) { }
        new Thread(() -> {
            try {
                byte[] sz = new JSONObject().put("w", width).put("h", height).toString().getBytes(StandardCharsets.UTF_8);
                send(sz, sz.length, 0, 4);
                ui.post(() -> { try { startEncoder(); } catch (Exception e) { finish("Cannot restart the video encoder"); } });
            } catch (Exception e) { finish("The TV stopped the cast"); }
        }).start();
    }

    private void finish(String error) {
        if (stopping) return;
        stopping = true;
        running = false;
        target = null;
        ui.post(() -> {
            MediaCodec enc = encoder;
            encoder = null;
            if (enc != null) { try { enc.stop(); } catch (Exception ignored) { } try { enc.release(); } catch (Exception ignored) { } }
            if (display != null) { try { display.release(); } catch (Exception ignored) { } display = null; }
            if (projection != null) { try { projection.stop(); } catch (Exception ignored) { } projection = null; }
            try { if (socket != null) socket.close(); } catch (Exception ignored) { }
            Listener l = listener;
            if (l != null) l.onState(false, error);
            stopForeground(true);
            stopSelf();
        });
    }

    @Override
    public void onDestroy() {
        finish(null);
        super.onDestroy();
    }
}
