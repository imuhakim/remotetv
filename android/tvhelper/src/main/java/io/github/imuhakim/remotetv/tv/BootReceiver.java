package io.github.imuhakim.remotetv.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the helper again after the TV restarts or the app is updated. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        try { HelperService.start(c); } catch (Exception ignored) { }
    }
}
