package io.github.imuhakim.remotetv;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RemoteTvPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
