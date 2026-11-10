package io.github.imuhakim.remotetv;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal HTTP/1.1 file server with Range support. It only serves files the
 * user picked, under unguessable tokens, so the TV's DLNA player can stream
 * them straight from the phone.
 */
class MediaServer {

    static class Entry {
        String token;
        Uri uri;
        String mime;
        String name;
        String ext;
        long size;
    }

    private final Context ctx;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;

    MediaServer(Context ctx) { this.ctx = ctx; }

    synchronized void start() throws Exception {
        if (server != null && !server.isClosed()) return;
        server = new ServerSocket(0);
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    new Thread(() -> handle(s)).start();
                } catch (Exception ignored) { }
            }
        }, "remotetv-media");
        t.setDaemon(true);
        t.start();
    }

    int port() { return server.getLocalPort(); }

    void stop() {
        try { if (server != null) server.close(); } catch (Exception ignored) { }
    }

    Entry add(Uri uri) {
        ContentResolver cr = ctx.getContentResolver();
        Entry e = new Entry();
        byte[] b = new byte[12];
        random.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x));
        e.token = sb.toString();
        e.uri = uri;
        e.mime = cr.getType(uri) != null ? cr.getType(uri) : "application/octet-stream";
        e.name = "media";
        e.size = -1;
        try (Cursor c = cr.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0) e.name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) e.size = c.getLong(si);
            }
        }
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(e.mime);
        e.ext = ext != null ? "." + ext : "";
        entries.put(e.token, e);
        return e;
    }

    private static final Pattern PATH = Pattern.compile("^(GET|HEAD) /m/([0-9a-f]{24})(\\.[\\w]+)? HTTP");
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    private void handle(Socket s) {
        try (Socket sock = s) {
            BufferedReader r = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = r.readLine();
            if (line == null) return;
            String range = null;
            String h;
            while ((h = r.readLine()) != null && !h.isEmpty()) {
                if (h.toLowerCase(Locale.US).startsWith("range:")) range = h.substring(6).trim();
            }
            OutputStream out = sock.getOutputStream();
            Matcher m = PATH.matcher(line);
            Entry e = m.find() ? entries.get(m.group(2)) : null;
            if (e == null) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                return;
            }
            boolean head = line.startsWith("HEAD");
            long size = e.size;
            long start = 0, end = size - 1;
            boolean partial = false;
            if (range != null && size > 0) {
                Matcher rm = RANGE.matcher(range);
                if (rm.find()) {
                    String a = rm.group(1), b = rm.group(2);
                    if (!a.isEmpty()) { start = Long.parseLong(a); if (!b.isEmpty()) end = Math.min(Long.parseLong(b), size - 1); }
                    else if (!b.isEmpty()) { start = Math.max(0, size - Long.parseLong(b)); }
                    partial = start > 0 || end < size - 1;
                }
            }
            StringBuilder hdr = new StringBuilder();
            hdr.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            hdr.append("Content-Type: ").append(e.mime).append("\r\n");
            if (size >= 0) hdr.append("Content-Length: ").append(end - start + 1).append("\r\n");
            if (partial) hdr.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
            hdr.append("Accept-Ranges: bytes\r\n");
            hdr.append("transferMode.dlna.org: ").append(e.mime.startsWith("image/") ? "Interactive" : "Streaming").append("\r\n");
            hdr.append("contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n");
            hdr.append("Connection: close\r\n\r\n");
            out.write(hdr.toString().getBytes(StandardCharsets.US_ASCII));
            if (head) return;
            try (InputStream in = ctx.getContentResolver().openInputStream(e.uri)) {
                if (in == null) return;
                long skipped = 0;
                while (skipped < start) {
                    long k = in.skip(start - skipped);
                    if (k <= 0) break;
                    skipped += k;
                }
                long remaining = size >= 0 ? end - start + 1 : Long.MAX_VALUE;
                byte[] buf = new byte[65536];
                int n;
                while (remaining > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, remaining))) > 0) {
                    out.write(buf, 0, n);
                    remaining -= n;
                }
                out.flush();
            }
        } catch (Exception ignored) {
            // TV closed the connection (normal when seeking)
        }
    }
}
