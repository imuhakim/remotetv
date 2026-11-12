package io.github.imuhakim.remotetv.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** On a TV, starts the drawing receiver again after a restart or an app update (never on phones). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        try { if (HelperService.isTv(c)) HelperService.start(c); } catch (Exception ignored) { }
    }
}
