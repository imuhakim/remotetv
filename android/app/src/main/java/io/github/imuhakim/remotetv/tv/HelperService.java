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

import io.github.imuhakim.remotetv.R;

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
    /** Browser drawing page for iPad / iPhone / laptop (http://<tv>:7334). */
    static final int HTTP_PORT = 7334;
    private static final String CHANNEL = "helper";
    private static final long CODE_MS = 120_000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;
    private ServerSocket httpServer;
    private CastReceiver cast;
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

    /** True on Android TV / Google TV: only there does the app act as the drawing receiver. */
    public static boolean isTv(Context c) {
        return c.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK);
    }

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
        startHttp();
        cast = new CastReceiver(this, this::validToken);
        cast.start();
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
        try { if (httpServer != null) httpServer.close(); } catch (Exception ignored) { }
        if (cast != null) cast.stop();
        try { if (nsd != null && nsdListener != null) nsd.unregisterService(nsdListener); } catch (Exception ignored) { }
        ui.post(this::detach);
        super.onDestroy();
    }

    private void goForeground() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "RemoteTV on TV", NotificationManager.IMPORTANCE_MIN));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Notification n = b.setContentTitle("RemoteTV")
                .setContentText("Ready for drawing from your phone")
                .setSmallIcon(R.drawable.ic_helper)
                .build();
        startForeground(1, n);
    }

    private void registerNsd() {
        try {
            nsd = (NsdManager) getSystemService(NSD_SERVICE);
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName("RemoteTV " + Build.MODEL);
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
                    r.put("ok", true).put("app", "RemoteTV").put("v", 1).put("overlay", canDraw(this));
                    Point size = screenSize();
                    r.put("w", size.x).put("h", size.y);
                    String token = m.optString("token", "");
                    authed = !token.isEmpty() && tokens().contains(token);
                    r.put("paired", authed);
                    if (!authed && canDraw(this)) showCode(m.optString("name", "A phone"));
                    reply(out, r);
                } else if (t.equals("pair")) {
                    JSONObject p = tryPair(m.optString("code", ""));
                    if (p.optBoolean("ok")) authed = true;
                    p.put("rid", m.optInt("rid", 0));
                    reply(out, p);
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

    /** Checks the code shown on the TV; on success stores and returns a new token. */
    private synchronized JSONObject tryPair(String code) throws Exception {
        JSONObject r = new JSONObject();
        boolean ok = pendingCode != null && System.currentTimeMillis() < pendingUntil && pendingTries < 5 && pendingCode.equals(code.trim());
        pendingTries++;
        if (ok) {
            String token = hex(16);
            Set<String> all = tokens();
            all.add(token);
            prefs.edit().putStringSet("tokens", all).apply();
            pendingCode = null;
            ui.post(hideCard);
            r.put("ok", true).put("token", token);
        } else {
            r.put("ok", false).put("error", pendingTries >= 5 ? "Too many tries. Connect again for a new code." : "Wrong code");
        }
        return r;
    }

    boolean validToken(String token) { return token != null && !token.isEmpty() && tokens().contains(token); }

    // ------------------------------------------------------- web page (7334)
    // Minimal HTTP/1.1 server: GET / serves the drawing page from the app's web
    // assets; POST /api/hello|pair|ops take and return JSON. Keep-alive is
    // supported so strokes from Safari do not open a connection each time.
    private void startHttp() {
        new Thread(() -> {
            try {
                httpServer = new ServerSocket(HTTP_PORT);
                while (running) {
                    final Socket s = httpServer.accept();
                    new Thread(() -> serveHttp(s)).start();
                }
            } catch (Exception ignored) { }
        }, "helper-http").start();
    }

    private static String readLine(java.io.InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') return sb.toString();
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) return null;
        }
        return sb.length() > 0 ? sb.toString() : null;
    }

    private void serveHttp(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(60_000);
            s.setTcpNoDelay(true);
            java.io.InputStream in = new java.io.BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            while (true) {
                String first = readLine(in);
                if (first == null || first.isEmpty()) return;
                String[] parts = first.split(" ");
                if (parts.length < 2) return;
                String method = parts[0], path = parts[1];
                int len = 0;
                boolean close = first.endsWith("HTTP/1.0");
                String h;
                while ((h = readLine(in)) != null && !h.isEmpty()) {
                    String lower = h.toLowerCase(Locale.US);
                    if (lower.startsWith("content-length:")) len = Integer.parseInt(h.substring(15).trim());
                    else if (lower.startsWith("connection:")) close = lower.contains("close");
                }
                if (len < 0 || len > 200_000) return;
                byte[] body = new byte[len];
                for (int off = 0; off < len; ) {
                    int n = in.read(body, off, len - off);
                    if (n < 0) return;
                    off += n;
                }
                if (method.equals("GET") && (path.equals("/") || path.startsWith("/?") || path.equals("/index.html"))) {
                    byte[] page;
                    try (java.io.InputStream a = getAssets().open("public/tvdraw.html")) {
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = a.read(buf)) > 0) bos.write(buf, 0, n);
                        page = bos.toByteArray();
                    }
                    respond(out, 200, "text/html; charset=utf-8", page, close);
                } else if (method.equals("POST") && path.startsWith("/api/")) {
                    JSONObject m;
                    try { m = new JSONObject(new String(body, StandardCharsets.UTF_8)); } catch (Exception e) { m = new JSONObject(); }
                    JSONObject r = api(path.substring(5), m);
                    respond(out, r.optBoolean("ok") ? 200 : 403, "application/json", r.toString().getBytes(StandardCharsets.UTF_8), close);
                } else {
                    respond(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), close);
                }
                if (close) return;
            }
        } catch (Exception ignored) { }
    }

    private JSONObject api(String name, JSONObject m) throws Exception {
        JSONObject r = new JSONObject();
        String token = m.optString("token", "");
        if (name.equals("hello")) {
            boolean paired = validToken(token);
            Point size = screenSize();
            r.put("ok", true).put("paired", paired).put("overlay", canDraw(this)).put("w", size.x).put("h", size.y);
            if (!paired && canDraw(this)) showCode(m.optString("name", "A browser"));
            return r;
        }
        if (name.equals("pair")) return tryPair(m.optString("code", ""));
        if (name.equals("ops")) {
            if (!validToken(token)) return r.put("ok", false).put("error", "Not paired");
            JSONArray ops = m.optJSONArray("ops");
            for (int i = 0; ops != null && i < ops.length() && i < 300; i++) {
                JSONObject op = ops.optJSONObject(i);
                if (op != null) draw(op.optString("t"), op);
            }
            return r.put("ok", true);
        }
        return r.put("ok", false).put("error", "Unknown request");
    }

    private static void respond(OutputStream out, int code, String type, byte[] body, boolean close) throws Exception {
        String head = "HTTP/1.1 " + code + (code == 200 ? " OK" : code == 404 ? " Not Found" : " Forbidden") + "\r\n"
                + "Content-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\n"
                + "Connection: " + (close ? "close" : "keep-alive") + "\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
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
