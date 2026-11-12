package io.github.imuhakim.remotetv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Base64;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Native pieces a WebView cannot do on its own:
 *  - SSDP (UDP multicast) and mDNS discovery of TVs
 *  - raw TLS sockets with a client certificate (Android TV Remote v2)
 *  - a tiny HTTP server so the TV can stream a phone file over DLNA
 *  - keep-screen-on
 * HTTP calls to TVs go through the built-in CapacitorHttp (no CORS).
 */
@CapacitorPlugin(name = "RemoteTv")
public class RemoteTvPlugin extends Plugin {

    private final Map<Integer, Conn> conns = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private MediaServer mediaServer;

    private static class Conn {
        SSLSocket socket;
        OutputStream out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
    }

    // ------------------------------------------------------------------ SSDP
    @PluginMethod
    public void ssdpSearch(PluginCall call) {
        final JSArray targets = call.getArray("targets", new JSArray());
        final int timeout = call.getInt("timeoutMs", 3000);
        new Thread(() -> {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("remotetv-ssdp") : null;
            JSArray out = new JSArray();
            try (DatagramSocket socket = new DatagramSocket()) {
                if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
                socket.setSoTimeout(250);
                InetAddress group = InetAddress.getByName("239.255.255.250");
                for (int i = 0; i < targets.length(); i++) {
                    String st = targets.getString(i);
                    String msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: " + st + "\r\n\r\n";
                    byte[] b = msg.getBytes(StandardCharsets.UTF_8);
                    socket.send(new DatagramPacket(b, b.length, group, 1900));
                }
                long end = System.currentTimeMillis() + timeout;
                byte[] buf = new byte[4096];
                while (System.currentTimeMillis() < end) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(p);
                        JSObject r = new JSObject();
                        r.put("text", new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                        r.put("address", p.getAddress().getHostAddress());
                        out.put(r);
                    } catch (SocketTimeoutException ignored) { }
                }
                JSObject ret = new JSObject();
                ret.put("responses", out);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("SSDP failed: " + e.getMessage());
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
        }).start();
    }

    // ------------------------------------------------------------------ mDNS
    @PluginMethod
    public void mdnsDiscover(PluginCall call) {
        final String type = call.getString("type", "_androidtvremote2._tcp");
        final int timeout = call.getInt("timeoutMs", 3000);
        new Thread(() -> {
            NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("remotetv-mdns") : null;
            final List<NsdServiceInfo> found = Collections.synchronizedList(new ArrayList<>());
            NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
                @Override public void onStartDiscoveryFailed(String s, int i) { }
                @Override public void onStopDiscoveryFailed(String s, int i) { }
                @Override public void onDiscoveryStarted(String s) { }
                @Override public void onDiscoveryStopped(String s) { }
                @Override public void onServiceFound(NsdServiceInfo info) { found.add(info); }
                @Override public void onServiceLost(NsdServiceInfo info) { }
            };
            JSArray out = new JSArray();
            try {
                if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
                nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
                Thread.sleep(timeout);
                try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) { }
                List<NsdServiceInfo> snapshot;
                synchronized (found) { snapshot = new ArrayList<>(found); }
                for (NsdServiceInfo info : snapshot) {
                    final CountDownLatch latch = new CountDownLatch(1);
                    final NsdServiceInfo[] resolved = new NsdServiceInfo[1];
                    nsd.resolveService(info, new NsdManager.ResolveListener() {
                        @Override public void onResolveFailed(NsdServiceInfo s, int err) { latch.countDown(); }
                        @Override public void onServiceResolved(NsdServiceInfo s) { resolved[0] = s; latch.countDown(); }
                    });
                    latch.await(3, TimeUnit.SECONDS);
                    if (resolved[0] != null && resolved[0].getHost() != null) {
                        JSObject r = new JSObject();
                        r.put("name", resolved[0].getServiceName());
                        r.put("host", resolved[0].getHost().getHostAddress());
                        r.put("port", resolved[0].getPort());
                        out.put(r);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("services", out);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("mDNS failed: " + e.getMessage());
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
        }).start();
    }

    // ------------------------------------------------------------------ TLS
    @PluginMethod
    public void tlsConnect(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 6466);
        final String certPem = call.getString("certPem");
        final String keyPem = call.getString("keyPem");
        final int timeout = call.getInt("timeoutMs", 6000);
        if (host == null || certPem == null || keyPem == null) { call.reject("host, certPem and keyPem are required"); return; }
        new Thread(() -> {
            try {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                X509Certificate cert = (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(pemBody(certPem)));
                PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(pemBody(keyPem)));
                char[] pw = "remotetv".toCharArray();
                KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
                ks.load(null, null);
                ks.setKeyEntry("client", key, pw, new Certificate[]{cert});
                KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(ks, pw);
                TrustManager[] trustAll = new TrustManager[]{new X509TrustManager() {
                    // The TV uses a self-signed certificate; trust is established by the pairing code.
                    @Override public void checkClientTrusted(X509Certificate[] c, String a) { }
                    @Override public void checkServerTrusted(X509Certificate[] c, String a) { }
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }};
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(kmf.getKeyManagers(), trustAll, new SecureRandom());

                java.net.Socket raw = new java.net.Socket();
                raw.connect(new InetSocketAddress(host, port), timeout);
                SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(raw, host, port, true);
                s.setUseClientMode(true);
                s.startHandshake();

                final int id = nextId.getAndIncrement();
                Conn c = new Conn();
                c.socket = s;
                c.out = s.getOutputStream();
                conns.put(id, c);

                Certificate[] peer = s.getSession().getPeerCertificates();
                JSObject ret = new JSObject();
                ret.put("id", id);
                ret.put("peerCert", Base64.encodeToString(peer[0].getEncoded(), Base64.NO_WRAP));
                call.resolve(ret);

                readLoop(id, s);
            } catch (Exception e) {
                call.reject("TLS connect failed: " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }).start();
    }

    private void readLoop(int id, SSLSocket s) {
        String error = null;
        try {
            InputStream in = s.getInputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                notifyListeners("tlsData", ev);
            }
        } catch (Exception e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        Conn c = conns.remove(id);
        if (c != null) c.writer.shutdown();
        JSObject ev = new JSObject();
        ev.put("id", id);
        if (error != null) ev.put("error", error);
        notifyListeners("tlsClose", ev);
    }

    @PluginMethod
    public void tlsWrite(PluginCall call) {
        final Conn c = conns.get(call.getInt("id", -1));
        if (c == null) { call.reject("Connection closed"); return; }
        final byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        c.writer.execute(() -> {
            try {
                c.out.write(data);
                c.out.flush();
                call.resolve();
            } catch (Exception e) {
                call.reject("TLS write failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void tlsClose(PluginCall call) {
        Conn c = conns.remove(call.getInt("id", -1));
        if (c != null) {
            try { c.socket.close(); } catch (Exception ignored) { }
            c.writer.shutdown();
        }
        call.resolve();
    }

    private static byte[] pemBody(String pem) {
        String b64 = pem.replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        return Base64.decode(b64, Base64.DEFAULT);
    }

    // ----------------------------------------------------------- media cast
    @PluginMethod
    public void pickMedia(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "*/*"));
        startActivityForResult(call, intent, "onMediaPicked");
    }

    @ActivityCallback
    private void onMediaPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            if (mediaServer == null) mediaServer = new MediaServer(getContext().getApplicationContext());
            mediaServer.start();
            MediaServer.Entry e = mediaServer.add(uri);
            String ip = localIpNear(call.getString("tvHost", ""));
            JSObject ret = new JSObject();
            ret.put("url", "http://" + ip + ":" + mediaServer.port() + "/m/" + e.token + e.ext);
            ret.put("mime", e.mime);
            ret.put("name", e.name);
            ret.put("size", e.size);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Cannot share file: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void localIp(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ip", localIpNear(call.getString("near", "")));
        call.resolve(ret);
    }

    static String localIpNear(String near) {
        String prefix = near != null && near.contains(".") ? near.substring(0, near.lastIndexOf('.') + 1) : "";
        String first = "127.0.0.1";
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address)) continue;
                    String ip = a.getHostAddress();
                    if (!prefix.isEmpty() && ip.startsWith(prefix)) return ip;
                    if (first.equals("127.0.0.1")) first = ip;
                }
            }
        } catch (Exception ignored) { }
        return first;
    }

    // ------------------------------------------------------------ wake-on-lan
    @PluginMethod
    public void wakeOnLan(PluginCall call) {
        final String mac = call.getString("mac", "").replaceAll("[^0-9a-fA-F]", "");
        if (mac.length() != 12) { call.reject("Invalid MAC address"); return; }
        new Thread(() -> {
            try (DatagramSocket socket = new DatagramSocket()) {
                byte[] pkt = new byte[102];
                for (int i = 0; i < 6; i++) pkt[i] = (byte) 0xff;
                for (int r = 0; r < 16; r++)
                    for (int i = 0; i < 6; i++)
                        pkt[6 + r * 6 + i] = (byte) Integer.parseInt(mac.substring(i * 2, i * 2 + 2), 16);
                socket.setBroadcast(true);
                InetAddress bcast = InetAddress.getByName("255.255.255.255");
                for (int k = 0; k < 3; k++) socket.send(new DatagramPacket(pkt, pkt.length, bcast, 9));
                call.resolve();
            } catch (Exception e) {
                call.reject("Wake-on-LAN failed: " + e.getMessage());
            }
        }).start();
    }

    // ------------------------------------------------------------- screen
    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    // ------------------------------------------------------------ infra-red
    private android.hardware.ConsumerIrManager ir() {
        return (android.hardware.ConsumerIrManager) getContext().getSystemService(Context.CONSUMER_IR_SERVICE);
    }

    @PluginMethod
    public void irInfo(PluginCall call) {
        JSObject r = new JSObject();
        boolean has = false;
        try {
            android.hardware.ConsumerIrManager m = ir();
            has = m != null && m.hasIrEmitter();
        } catch (Exception ignored) { }
        r.put("hasIr", has);
        call.resolve(r);
    }

    /** pattern: alternating on/off durations in microseconds, starting with "on". */
    @PluginMethod
    public void irTransmit(PluginCall call) {
        final int freq = call.getInt("frequency", 40000);
        final JSArray arr = call.getArray("pattern");
        new Thread(() -> {
            try {
                android.hardware.ConsumerIrManager m = ir();
                if (m == null || !m.hasIrEmitter()) { call.reject("This phone has no infra-red emitter"); return; }
                List<Integer> list = arr.toList();
                int[] pattern = new int[list.size()];
                for (int i = 0; i < pattern.length; i++) pattern[i] = ((Number) (Object) list.get(i)).intValue();
                m.transmit(freq, pattern);
                call.resolve();
            } catch (Exception e) {
                call.reject("IR send failed: " + e.getMessage());
            }
        }).start();
    }

    // ------------------------------------------------------- share to TV
    private static String sharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        CharSequence t = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        return t == null ? null : t.toString();
    }

    /** Text shared to the app when it was launched by a Share action (then cleared). */
    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject r = new JSObject();
        Intent intent = getActivity().getIntent();
        String text = sharedText(intent);
        if (text != null) {
            r.put("text", text);
            intent.setAction(Intent.ACTION_MAIN);
            intent.removeExtra(Intent.EXTRA_TEXT);
        }
        call.resolve(r);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = sharedText(intent);
        if (text == null) return;
        JSObject ev = new JSObject();
        ev.put("text", text);
        notifyListeners("shared", ev, true);
    }

    @Override
    protected void handleOnDestroy() {
        for (Conn c : conns.values()) {
            try { c.socket.close(); } catch (Exception ignored) { }
        }
        conns.clear();
        if (mediaServer != null) mediaServer.stop();
    }
}
