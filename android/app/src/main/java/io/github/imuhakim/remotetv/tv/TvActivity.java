package io.github.imuhakim.remotetv.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/** Shown when RemoteTV is opened on a TV: starts the drawing receiver and shows what is still needed. */
public class TvActivity extends Activity {
    private TextView status;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        HelperService.start(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(80, 60, 80, 60);
        root.setBackgroundColor(Color.rgb(13, 11, 20));

        TextView title = new TextView(this);
        title.setText("RemoteTV on this TV");
        title.setTextColor(Color.WHITE);
        title.setTextSize(34);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        status = new TextView(this);
        status.setTextColor(Color.rgb(200, 196, 214));
        status.setTextSize(20);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, 30, 0, 30);
        root.addView(status);

        Button allow = button("Allow drawing over other apps", v -> openOverlaySettings());
        root.addView(allow);
        root.addView(button("Forget paired phones", v -> { HelperService.forgetPhones(this); refresh("Paired phones forgotten."); }));
        root.addView(button("Done", v -> finish()));
        setContentView(root);
        allow.requestFocus();
    }

    private Button button(String text, View.OnClickListener l) {
        Button btn = new Button(this);
        btn.setText(text);
        btn.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 16;
        btn.setLayoutParams(lp);
        return btn;
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh(null);
    }

    private void refresh(String extra) {
        boolean ok = HelperService.canDraw(this);
        String ip = localIp();
        StringBuilder sb = new StringBuilder();
        sb.append("Running").append(ip != null ? " at " + ip + ":" + HelperService.PORT : "").append("\n\n");
        if (ok) sb.append("✓ Ready. On your phone open RemoteTV › More › Draw on TV.");
        else sb.append("✗ Drawing over other apps is not allowed yet.\nChoose the button below, or on your phone use RemoteTV › More › Draw on TV › Install on the TV, which allows it automatically.");
        if (extra != null) sb.append("\n\n").append(extra);
        status.setText(sb.toString());
    }

    private void openOverlaySettings() {
        if (Build.VERSION.SDK_INT < 23) { refresh("Nothing to allow on this Android version."); return; }
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            refresh("This TV has no settings screen for it. Use the phone: RemoteTV › More › Draw on TV › Install on the TV (Advanced mode).");
        }
    }

    private String localIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return null;
    }
}
