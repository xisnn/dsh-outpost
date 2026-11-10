package com.dshpocket.agent.background;

import android.view.Surface;

interface IBackgroundDisplayService {
    int createDisplay(in Surface surface, int width, int height, int dpi) = 1;
    void launchComponent(int displayId, String component) = 2;
    void releaseDisplay(int displayId) = 3;
    String info() = 4;
    void injectKey(int displayId, String key) = 5;
    void injectText(int displayId, String text) = 6;

    void destroy() = 16777114;
}
