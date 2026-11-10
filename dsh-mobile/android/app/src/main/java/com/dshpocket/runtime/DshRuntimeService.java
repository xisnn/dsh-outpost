package com.dshpocket.runtime;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.util.concurrent.TimeUnit;

/** User-started file/network processing, bounded even on pre-35 Android. No boot restart. */
public final class DshRuntimeService extends Service {
  public static final String STOP="com.dshpocket.runtime.STOP";
  private static final java.util.concurrent.ConcurrentHashMap<String,java.util.concurrent.CompletableFuture<org.json.JSONObject>> starts=new java.util.concurrent.ConcurrentHashMap<>();
  public static java.util.concurrent.CompletableFuture<org.json.JSONObject> launch(Context context,String acknowledgedGeneration) {
    java.util.concurrent.CompletableFuture<org.json.JSONObject> future=new java.util.concurrent.CompletableFuture<>();
    String ticket=java.util.UUID.randomUUID().toString();starts.put(ticket,future);
    Intent intent=new Intent(context,DshRuntimeService.class).putExtra("ticket",ticket).putExtra("acknowledgedGeneration",acknowledgedGeneration);
    try { if(Build.VERSION.SDK_INT>=26)context.startForegroundService(intent);else context.startService(intent); }
    catch(Exception e){starts.remove(ticket);future.completeExceptionally(e);}
    // Start includes a full payload verification before launch; P1 observed
    // 223 seconds on a cold device. Ten seconds falsely reported failure while
    // the same start continued in the background.
    new Handler(Looper.getMainLooper()).postDelayed(()->{if(starts.remove(ticket,future))future.completeExceptionally(new java.io.IOException("START_NOT_CONFIRMED"));},300000);
    return future;
  }
  private static final String CHANNEL="outpost-local-runtime";
  private static final int NOTIFICATION=4107;
  private final Handler handler=new Handler(Looper.getMainLooper());
  private PowerManager.WakeLock wakeLock;
  private RuntimeSupervisor supervisor;
  private boolean started;
  private volatile boolean launchPending;
  private java.util.concurrent.CompletableFuture<org.json.JSONObject> launchFuture;
  private final Runnable stoppedCallback=this::finish;
  private final Runnable deadline=()->interrupt("execution-time-limit");
  @Override public void onCreate() {
    super.onCreate();
    if(Build.VERSION.SDK_INT>=26) getSystemService(NotificationManager.class).createNotificationChannel(
        new NotificationChannel(CHANNEL,"本机 DSH 任务",NotificationManager.IMPORTANCE_LOW));
  }
  @Override public int onStartCommand(Intent intent,int flags,int startId) {
    if(intent==null || STOP.equals(intent.getAction())){interrupt("user-stop");return START_NOT_STICKY;}
    String ticket=intent.getStringExtra("ticket");
    java.util.concurrent.CompletableFuture<org.json.JSONObject> result=ticket==null?null:starts.remove(ticket);
    if(started){
      if(launchPending && launchFuture!=null){
        if(result!=null)launchFuture.whenComplete((value,error)->{if(error!=null)result.completeExceptionally(error);else result.complete(value);});
      } else try {
        org.json.JSONObject current=supervisor.snapshot();String phase=current.getString("phase");
        if(!"running".equals(phase)&&!"starting".equals(phase)){
          if(result!=null)result.completeExceptionally(new java.io.IOException("SERVICE_STOPPING"));finish();
        } else if(result!=null)result.complete(current);
      }catch(Exception e){if(result!=null)result.completeExceptionally(e);}
      return START_NOT_STICKY;
    }
    try {
      // dataSync is used for the controlled file/network workload, never an idle daemon.
      Intent open=getPackageManager().getLaunchIntentForPackage(getPackageName());
      PendingIntent content=open==null?null:PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
      PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,DshRuntimeService.class).setAction(STOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
      Notification.Builder builder=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,CHANNEL):new Notification.Builder(this);
      Notification notification=builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("DSH 正在处理本机任务")
          .setContentText("可随时停止；中断后需核对任务状态").setContentIntent(content).setOngoing(true)
          .addAction(new Notification.Action.Builder(null,"停止",stop).build()).build();
      if(Build.VERSION.SDK_INT>=29)startForeground(NOTIFICATION,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
      else startForeground(NOTIFICATION,notification);
      if(result==null){finish();return START_NOT_STICKY;}
      started=true;supervisor=RuntimeSupervisor.get(this);
      supervisor.onStopped(stoppedCallback);
      wakeLock=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":local-dsh");
      wakeLock.acquire(TimeUnit.MINUTES.toMillis(15));
      handler.postDelayed(deadline,TimeUnit.MINUTES.toMillis(15));
      launchPending=true;
      launchFuture=supervisor.start(intent.getStringExtra("acknowledgedGeneration"));
      launchFuture.whenComplete((snapshot,error)->{
        launchPending=false;
        if(error!=null){result.completeExceptionally(error);handler.post(this::finish);}else result.complete(snapshot);
      });
    } catch(Exception failure) {if(result!=null)result.completeExceptionally(failure);if(supervisor!=null)supervisor.stop("foreground-service-denied",true);finish();}
    return START_NOT_STICKY;
  }
  private void interrupt(String reason) {
    try{RuntimeSupervisor.get(this).stop(reason,!"user-stop".equals(reason));}catch(Exception ignored){}
    // Android's timeout callback has only a few seconds: remove the FGS immediately;
    // native cleanup continues without depending on RN.
    finish();
  }
  private void finish(){handler.removeCallbacks(deadline);if(wakeLock!=null&&wakeLock.isHeld())wakeLock.release();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
  @Override public void onTimeout(int startId,int fgsType){interrupt("system-service-timeout");}
  @Override public void onTimeout(int startId){interrupt("system-service-timeout");}
  @Override public void onDestroy(){handler.removeCallbacks(deadline);if(wakeLock!=null&&wakeLock.isHeld())wakeLock.release();
    if(supervisor!=null){
      supervisor.clearStoppedCallback(stoppedCallback);
      // Verification can still be hashing the payload, before journal.begin().
      // Avoid disk verification on the main thread while cancelling that launch.
      if(launchPending||supervisor.hasProcess())supervisor.stop("service-destroyed",true);
    }
    super.onDestroy();}
  @Override public IBinder onBind(Intent intent){return null;}
}
