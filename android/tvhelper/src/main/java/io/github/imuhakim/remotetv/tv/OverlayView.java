package io.github.imuhakim.remotetv.tv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.view.View;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Transparent full-screen layer drawn on top of every app. Coordinates from the
 * phone are 0..1 fractions of the screen so any phone/TV size matches. All
 * methods run on the UI thread.
 */
public class OverlayView extends View {
    private static class Stroke {
        final Path path = new Path();
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        float lx, ly;
    }

    private static class Label {
        String text;
        float x, y;
        TextPaint paint;
    }

    private final List<Object> items = new ArrayList<>(); // Stroke or Label, in drawing order (for undo)
    private final Map<Integer, Stroke> active = new HashMap<>();
    private String cardTitle, cardText;
    private final Paint cardBg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint cardTitlePaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint cardPaint = new TextPaint(Paint.ANTI_ALIAS_FLAG);

    private final int sw, sh; // screen size in pixels (known before the first layout)

    public OverlayView(Context c, int screenW, int screenH) {
        super(c);
        sw = screenW;
        sh = screenH;
        setLayerType(LAYER_TYPE_HARDWARE, null);
        cardBg.setColor(Color.argb(225, 20, 16, 36));
        cardTitlePaint.setColor(Color.rgb(190, 175, 255));
        cardPaint.setColor(Color.WHITE);
        cardPaint.setFakeBoldText(true);
    }

    static int parseColor(String s, int fallback) {
        try { return Color.parseColor(s); } catch (Exception e) { return fallback; }
    }

    public void begin(int id, String color, float width, float x, float y) {
        Stroke s = new Stroke();
        s.paint.setStyle(Paint.Style.STROKE);
        s.paint.setStrokeCap(Paint.Cap.ROUND);
        s.paint.setStrokeJoin(Paint.Join.ROUND);
        s.paint.setColor(parseColor(color, Color.RED));
        s.paint.setStrokeWidth(Math.max(2f, Math.min(0.08f, width) * sw));
        s.lx = x * sw;
        s.ly = y * sh;
        s.path.moveTo(s.lx, s.ly);
        s.path.lineTo(s.lx + 0.1f, s.ly + 0.1f); // a tap shows a dot
        active.put(id, s);
        items.add(s);
        invalidate();
    }

    public void move(int id, float[] pts) {
        Stroke s = active.get(id);
        if (s == null) return;
        for (int i = 0; i + 1 < pts.length; i += 2) {
            float x = pts[i] * sw, y = pts[i + 1] * sh;
            s.path.quadTo(s.lx, s.ly, (s.lx + x) / 2f, (s.ly + y) / 2f);
            s.lx = x;
            s.ly = y;
        }
        invalidate();
    }

    public void end(int id) {
        Stroke s = active.remove(id);
        if (s != null) { s.path.lineTo(s.lx, s.ly); invalidate(); }
    }

    public void text(String text, float x, float y, String color, float size) {
        Label l = new Label();
        l.text = text;
        l.x = x * sw;
        l.y = y * sh;
        l.paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        l.paint.setColor(parseColor(color, Color.WHITE));
        l.paint.setFakeBoldText(true);
        l.paint.setTextSize(Math.max(12f, Math.min(0.2f, size) * sh));
        l.paint.setShadowLayer(6f, 0, 2f, Color.BLACK);
        items.add(l);
        invalidate();
    }

    public void undo() {
        if (items.isEmpty()) return;
        Object last = items.remove(items.size() - 1);
        active.values().remove(last);
        invalidate();
    }

    public void clear() {
        items.clear();
        active.clear();
        invalidate();
    }

    public boolean isEmpty() { return items.isEmpty() && cardText == null; }

    /** A centred message card (pairing code, or a message from the phone). Null hides it. */
    public void card(String title, String text) {
        cardTitle = title;
        cardText = text;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        for (Object o : items) {
            if (o instanceof Stroke) {
                Stroke s = (Stroke) o;
                c.drawPath(s.path, s.paint);
            } else {
                Label l = (Label) o;
                c.drawText(l.text, l.x, l.y, l.paint);
            }
        }
        if (cardText != null) drawCard(c);
    }

    private void drawCard(Canvas c) {
        int w = getWidth() > 0 ? getWidth() : sw, h = getHeight() > 0 ? getHeight() : sh;
        float pad = h * 0.035f;
        cardPaint.setTextSize(h * 0.06f);
        cardTitlePaint.setTextSize(h * 0.03f);
        int textW = (int) (w * 0.6f);
        StaticLayout body = new StaticLayout(cardText, cardPaint, textW, Layout.Alignment.ALIGN_CENTER, 1f, 0f, false);
        float titleH = cardTitle != null ? cardTitlePaint.getTextSize() * 1.6f : 0;
        float boxW = textW + pad * 2, boxH = body.sh + titleH + pad * 2;
        float left = (w - boxW) / 2f, top = h * 0.72f - boxH / 2f;
        c.drawRoundRect(new RectF(left, top, left + boxW, top + boxH), pad, pad, cardBg);
        if (cardTitle != null) {
            float tw = cardTitlePaint.measureText(cardTitle);
            c.drawText(cardTitle, (w - tw) / 2f, top + pad + cardTitlePaint.getTextSize(), cardTitlePaint);
        }
        c.save();
        c.translate(left + pad, top + pad + titleH);
        body.draw(c);
        c.restore();
    }
}
