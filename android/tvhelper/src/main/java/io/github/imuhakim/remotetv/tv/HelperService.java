package io.github.imuhakim.remotetv.tv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Listens on TCP 7333 for the RemoteTV phone app. Protocol: one JSON object per
 * line. A phone must pair once (the TV shows a 6-digit code) and then sends its
 * token in "hello". Paired phones can draw strokes, text and message cards on a
 * transparent overlay above all apps.
 */
public class HelperService extends Service {
    static final int PORT = 7333;
    private static final String CHANNEL = "helper";
    private static final long CODE_MS = 120_000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;
    private volatile boolean running;
    private WindowManager wm;
    private OverlayView overlay;
    private boolean attached;
    private SharedPreferences prefs;
    private NsdManager nsd;
    private NsdManager.RegistrationListener nsdListener;

    private String pendingCode;
    private long pendingUntil;
    private int pendingTries;
    private final Runnable hideCard = () -> { if (overlay != null) { overlay.card(null, null); detachIfEmpty(); } };

    public static void start(Context c) {
        Intent i = new Intent(c, HelperService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static boolean canDraw(Context c) {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("helper", MODE_PRIVATE);
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        goForeground();
        startServer();
        registerNsd();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        try { if (nsd != null && nsdListener != null) nsd.unregisterService(nsdListener); } catch (Exception ignored) { }
        ui.post(this::detach);
        super.onDestroy();
    }

    private void goForeground() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "RemoteTV Helper", NotificationManager.IMPORTANCE_MIN));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Notification n = b.setContentTitle("RemoteTV Helper")
                .setContentText("Ready for drawing from your phone")
                .setSmallIcon(R.drawable.ic_helper)
                .build();
        startForeground(1, n);
    }

    private void registerNsd() {
        try {
            nsd = (NsdManager) getSystemService(NSD_SERVICE);
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName("RemoteTV Helper " + Build.MODEL);
            info.setServiceType("_remotetvhelper._tcp");
            info.setPort(PORT);
            nsdListener = new NsdManager.RegistrationListener() {
                @Override public void onRegistrationFailed(NsdServiceInfo s, int e) { }
                @Override public void onUnregistrationFailed(NsdServiceInfo s, int e) { }
                @Override public void onServiceRegistered(NsdServiceInfo s) { }
                @Override public void onServiceUnregistered(NsdServiceInfo s) { }
            };
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, nsdListener);
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------- server
    private void startServer() {
        running = true;
        new Thread(() -> {
            try {
                server = new ServerSocket(PORT);
                while (running) {
                    final Socket s = server.accept();
                    new Thread(() -> handle(s)).start();
                }
            } catch (Exception ignored) { }
        }, "helper-server").start();
    }

    private Set<String> tokens() { return new HashSet<>(prefs.getStringSet("tokens", new HashSet<>())); }

    static void forgetPhones(Context c) {
        c.getSharedPreferences("helper", MODE_PRIVATE).edit().remove("tokens").apply();
    }

    private void handle(Socket sock) {
        boolean authed = false;
        try (Socket s = sock) {
            s.setTcpNoDelay(true);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = s.getOutputStream();
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty() || line.length() > 200_000) continue;
                JSONObject m;
                try { m = new JSONObject(line); } catch (Exception e) { continue; }
                String t = m.optString("t");
                JSONObject r = new JSONObject();
                r.put("rid", m.optInt("rid", 0));
                if (t.equals("hello")) {
                    r.put("ok", true).put("app", "RemoteTV Helper").put("v", 1).put("overlay", canDraw(this));
                    Point size = screenSize();
                    r.put("w", size.x).put("h", size.y);
                    String token = m.optString("token", "");
                    authed = !token.isEmpty() && tokens().contains(token);
                    r.put("paired", authed);
                    if (!authed && canDraw(this)) showCode(m.optString("name", "A phone"));
                    reply(out, r);
                } else if (t.equals("pair")) {
                    String code = m.optString("code", "").trim();
                    boolean ok = pendingCode != null && System.currentTimeMillis() < pendingUntil && pendingTries < 5 && pendingCode.equals(code);
                    pendingTries++;
                    if (ok) {
                        String token = hex(16);
                        Set<String> all = tokens();
                        all.add(token);
                        prefs.edit().putStringSet("tokens", all).apply();
                        pendingCode = null;
                        authed = true;
                        ui.post(hideCard);
                        r.put("ok", true).put("token", token);
                    } else {
                        r.put("ok", false).put("error", pendingTries >= 5 ? "Too many tries. Connect again for a new code." : "Wrong code");
                    }
                    reply(out, r);
                } else if (t.equals("ping")) {
                    reply(out, r.put("ok", true));
                } else if (authed) {
                    draw(t, m);
                } else {
                    reply(out, r.put("ok", false).put("error", "Not paired"));
                }
            }
        } catch (Exception ignored) { }
    }

    private static synchronized void reply(OutputStream out, JSONObject r) throws Exception {
        out.write((r.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private String hex(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x));
        return sb.toString();
    }

    private void showCode(String name) {
        pendingCode = String.format(Locale.US, "%06d", random.nextInt(1_000_000));
        pendingUntil = System.currentTimeMillis() + CODE_MS;
        pendingTries = 0;
        final String code = pendingCode;
        ui.post(() -> {
            attach();
            if (overlay == null) return;
            overlay.card(name + " wants to draw on this TV", "Code: " + code.substring(0, 3) + " " + code.substring(3));
            ui.removeCallbacks(hideCard);
            ui.postDelayed(hideCard, CODE_MS);
        });
    }

    // ------------------------------------------------------------ drawing
    private void draw(String t, JSONObject m) {
        ui.post(() -> {
            if (t.equals("hide")) { detach(); return; }
            attach();
            if (overlay == null) return;
            switch (t) {
                case "begin":
                    overlay.begin(m.optInt("id"), m.optString("c", "#ff3b30"), (float) m.optDouble("w", 0.006), (float) m.optDouble("x"), (float) m.optDouble("y"));
                    break;
                case "move": {
                    JSONArray p = m.optJSONArray("p");
                    if (p == null) break;
                    float[] pts = new float[p.length()];
                    for (int i = 0; i < pts.length; i++) pts[i] = (float) p.optDouble(i);
                    overlay.move(m.optInt("id"), pts);
                    break;
                }
                case "end": overlay.end(m.optInt("id")); break;
                case "undo": overlay.undo(); break;
                case "clear": overlay.clear(); overlay.card(null, null); break;
                case "text":
                    overlay.text(m.optString("text"), (float) m.optDouble("x", 0.1), (float) m.optDouble("y", 0.15), m.optString("c", "#ffffff"), (float) m.optDouble("s", 0.07));
                    break;
                case "msg": {
                    String text = m.optString("text");
                    overlay.card(m.optString("title", null), text.isEmpty() ? null : text);
                    ui.removeCallbacks(hideCard);
                    int secs = Math.max(2, Math.min(600, m.optInt("secs", 15)));
                    ui.postDelayed(hideCard, secs * 1000L);
                    break;
                }
                default: break;
            }
        });
    }

    private Point screenSize() {
        Point p = new Point();
        try { wm.getDefaultDisplay().getRealSize(p); } catch (Exception e) { p.set(1920, 1080); }
        return p;
    }

    private void attach() {
        if (attached || !canDraw(this)) return;
        if (overlay == null) { Point size = screenSize(); overlay = new OverlayView(this, size.x, size.y); }
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        try {
            wm.addView(overlay, lp);
            attached = true;
        } catch (Exception e) {
            overlay = null;
        }
    }

    private void detach() {
        if (!attached || overlay == null) return;
        try { wm.removeView(overlay); } catch (Exception ignored) { }
        attached = false;
        overlay.clear();
        overlay.card(null, null);
    }

    private void detachIfEmpty() {
        if (overlay != null && overlay.isEmpty()) detach();
    }
}
