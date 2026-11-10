package com.dshpocket.runtime;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import com.dshpocket.runtime.install.RuntimeInstaller;
import com.dshpocket.runtime.install.RuntimeManifest;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

/** Application-owned, never Activity/RN-owned. It does not implement a TaskManager. */
public final class RuntimeSupervisor {
  private static RuntimeSupervisor instance;
  public static synchronized RuntimeSupervisor get(Context context) throws Exception {
    if(instance==null) instance=new RuntimeSupervisor(context.getApplicationContext()); return instance;
  }
  public interface Observer { void changed(); }
  private final Context context;
  private final RuntimeJournal journal;
  private final RuntimeInstaller installer;
  private final ExecutorService commands=Executors.newSingleThreadExecutor();
  private final ScheduledExecutorService timers=Executors.newSingleThreadScheduledExecutor();
  private final Handler main=new Handler(Looper.getMainLooper());
  private final Map<String,CompletableFuture<JSONObject>> pending=new ConcurrentHashMap<>();
  private volatile Observer observer;
  private volatile Runnable stopped;
  private volatile Process process;
  private volatile RuntimeWire wire;
  private volatile String generation;
  private volatile JSONObject installationCache;
  private JSONObject installation() throws Exception {
    JSONObject cached=installationCache;
    if(cached==null){synchronized(installer){if(installationCache==null)installationCache=installer.summary();cached=installationCache;}}
    return new JSONObject(cached.toString());
  }
  private volatile long heartbeat,lastTick,idleSince;
  private static volatile boolean appForeground;
  private volatile String activity="busy";
  private volatile int owner;
  private volatile boolean stopping;
  private volatile String endReason="user-stop";
  private final Object outputLock=new Object();
  private RuntimeSupervisor(Context context) throws Exception {
    this.context=context;
    File root=new File(context.getNoBackupFilesDir(),"outpost-local-v1");
    journal=new RuntimeJournal(new File(root,"supervisor"));
    installer=new RuntimeInstaller(new File(root,"runtime"),new File(root,"data"),1,Build.SUPPORTED_ABIS[0]);
    lastTick=SystemClock.elapsedRealtime();
    timers.scheduleAtFixedRate(()->{
      long now=SystemClock.elapsedRealtime(),gap=now-lastTick;lastTick=now;
      if(process!=null && !stopping && (gap>20000 || heartbeat>0 && now-heartbeat>15000))
        stop(gap>20000?"scheduler-interrupted":"heartbeat-lost",true);
      // A pending approval is human-paced. Keep the service alive (the 15-minute
      // cap still applies) instead of stopping 30 seconds after the card appears.
      if(process!=null && !stopping && !appForeground && idleSince>0 && now-idleSince>30000 && "idle".equals(activity))
        stop("idle-runtime",true);
    },1,1,TimeUnit.SECONDS);
  }
  public boolean hasProcess() { return process!=null; }
  public synchronized void attach(Observer observer) { this.observer=observer; }
  public synchronized void detach(Observer observer) { if(this.observer==observer)this.observer=null; }
  public static void setAppForeground(boolean value) { appForeground=value; }
  public synchronized void onStopped(Runnable callback) { stopped=callback; }
  public synchronized void clearStoppedCallback(Runnable expected) { if(stopped==expected)stopped=null; }
  private void changed() { Observer sink=observer;if(sink!=null)try{sink.changed();}catch(Exception ignored){} }
  private void phase(String phase,String reason,boolean reconcile) throws Exception { journal.transition(phase,reason,reconcile);changed(); }
  public JSONObject snapshot() throws Exception {
    JSONObject result=journal.snapshot();
    try{result.put("installed",installation());}
    catch(Exception failure){
      JSONObject cached=installationCache;
      if(cached!=null)result.put("installed",new JSONObject(cached.toString()));
      else result.put("installed",new JSONObject().put("installed",false).put("error","INSTALLATION_STATE"));
    }
    long heartbeatAt=heartbeat,nowTick=SystemClock.elapsedRealtime();
    result.put("live",process!=null && process.isAlive()).put("lastHeartbeatElapsedMs",heartbeatAt==0?0:Math.max(0,nowTick-heartbeatAt))
        .put("verificationExpiresElapsedMs",heartbeatAt==0?0:Math.max(0,heartbeatAt+15000-nowTick))
        .put("notificationPermission",Build.VERSION.SDK_INT<33 || context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")==0);
    return result;
  }
  public JSONObject events(long after) throws Exception {return journal.read(after);}
  public CompletableFuture<JSONObject> install(File artifact,RuntimeManifest trustedManifest) {
    return submit(()->{ensureStopped();JSONObject result;
      try{result=installer.install(artifact,trustedManifest);}catch(Exception failure){throw failure;}
      installationCache=result;journal.append("installation",new JSONObject().put("result","activated"));changed();return result;});
  }
  public CompletableFuture<JSONObject> rollback() {
    return submit(()->{ensureStopped();JSONObject result;try{result=installer.rollback();}catch(Exception failure){throw failure;}installationCache=result;journal.append("installation",new JSONObject().put("result","rolled-back"));changed();return result;});
  }
  private void ensureStopped() throws Exception {
    if(process!=null || "stop-unconfirmed".equals(journal.snapshot().getString("phase"))) throw new IOException("RUNTIME_MUST_BE_STOPPED");
    requireNoOtherAppProcess();
  }
  /** This APK has one Android process and no shared UID. Refuse to overlap an old
   * native launch after an app crash, including children whose owner already exited. */
  private void requireNoOtherAppProcess() throws Exception {
    File[] entries=new File("/proc").listFiles();if(entries==null)throw new IOException("PROCESS_OWNERSHIP_UNAVAILABLE");
    for(File entry:entries){String name=entry.getName();if(!name.matches("[0-9]+"))continue;
      int pid;try{pid=Integer.parseInt(name);}catch(NumberFormatException ignored){continue;}
      if(pid==android.os.Process.myPid())continue;
      try{if(Os.stat(entry.toString()).st_uid==android.os.Process.myUid()
          && isRuntimeProcess(pid))throw new IOException("PRIOR_APP_PROCESS_PRESENT");}
      catch(ErrnoException goneOrForeign){/* Android hides foreign UIDs; disappearing entries are normal. */}
    }
  }
  public CompletableFuture<JSONObject> start(String acknowledgedGeneration) {
    return submit(()->{
      if(stopping)throw new IOException("RUNTIME_STOPPING");
      if(process!=null) return snapshot();
      ensureStopped();JSONObject before=journal.snapshot();
      if(before.optBoolean("requiresReconciliation") && !before.isNull("generation") && !before.optString("generation").equals(acknowledgedGeneration))
        throw new IOException("RECONCILIATION_REQUIRED");
      if(Build.VERSION.SDK_INT<28 || !("arm64-v8a".equals(Build.SUPPORTED_ABIS[0]) || "x86_64".equals(Build.SUPPORTED_ABIS[0]))) throw new IOException("LOCAL_RUNTIME_UNSUPPORTED");
      JSONObject installation=installer.current();installationCache=installation;if(!installation.optBoolean("installed"))throw new IOException("RUNTIME_NOT_INSTALLED");
      if(stopping)throw new IOException("RUNTIME_STOPPING");
      requireNoOtherAppProcess();
      String nativeDir=context.getApplicationInfo().nativeLibraryDir;
      File runner=new File(nativeDir,"libdsh-runtime-runner.so"),proot=new File(nativeDir,"libproot.so");
      if(!runner.isFile() || !proot.isFile()) throw new IOException("RUNTIME_NATIVE_COMPONENT_MISSING");
      String guest=installation.getString("path"),entry="/"+installation.getString("entrypointRelative");
      String data=installation.getString("dataPath");
      new File(data,"home").mkdirs();new File(data,"workspace").mkdirs();new File(data,"tmp").mkdirs();
      File l2s=new File(data,"link-aliases");if(!l2s.isDirectory()&&!l2s.mkdirs())throw new IOException("RUNTIME_DATA_DIRECTORY");
      // Stop uses this same monitor. Cancellation cannot land between the final
      // check and process publication, and must never be reset by a pending start.
      synchronized(this) {
      if(stopping)throw new IOException("RUNTIME_STOPPING");
      generation=UUID.randomUUID().toString();byte[] secret=new byte[32];new SecureRandom().nextBytes(secret);
      wire=new RuntimeWire(generation,secret);owner=0;heartbeat=0;idleSince=0;activity="busy";
      journal.begin(generation);changed();
      // Binds put all writable business data outside the replaceable runtime generation.
      List<String> argv=Arrays.asList(runner.toString(),proot.toString(),"--kill-on-exit","--link2symlink","-L","--sysvipc","-0",
          "-r",guest,"-b",guest+":"+guest,"-b","/dev","-b","/proc","-b",data+":/outpost-data","-b",data+":"+data,"-b",data+"/tmp:/tmp","-w","/opt/dsh",
          "/usr/bin/env","HOME=/outpost-data/home","DSH_HOME=/outpost-data/home/.dsh","PATH=/opt/node/bin:/usr/bin:/bin",
          "UV_USE_IO_URING=0","NARB_DISABLE_NATIVE_CACHE=1","/opt/node/bin/node",entry);
      ProcessBuilder builder=new ProcessBuilder(argv).directory(context.getFilesDir());
      builder.environment().clear();builder.environment().put("LD_LIBRARY_PATH",nativeDir);
      builder.environment().put("PROOT_LOADER",nativeDir+"/libproot-loader.so");builder.environment().put("PROOT_TMP_DIR",context.getCacheDir().toString());
      builder.environment().put("PROOT_L2S_DIR",l2s.toString());builder.environment().put("OUTPOST_LAUNCH_ID",generation);
      builder.environment().put("OUTPOST_PIPE_TOKEN",Base64.encodeToString(secret,Base64.NO_WRAP));
      try {
        Process launched=builder.start();process=launched;lastTick=SystemClock.elapsedRealtime();
        Thread stderr=new Thread(()->{try(InputStream in=launched.getErrorStream()){byte[] discard=new byte[4096];while(in.read(discard)!=-1){/* Never persist raw DSH output or secrets. */}}catch(Exception ignored){}},"OutpostRuntimeStderr");stderr.setDaemon(true);stderr.start();
        Thread reader=new Thread(()->read(launched),"OutpostRuntimePipe");reader.setDaemon(true);reader.start();
        Thread waiter=new Thread(()->waitForExit(launched),"OutpostRuntimeExit");waiter.setDaemon(true);waiter.start();
        timers.schedule(()->{if(process==launched && heartbeat==0)stop("startup-timeout",true);},45,TimeUnit.SECONDS);
        return snapshot();
      } catch(Exception e) {process=null;phase("interrupted","launch-failed",true);throw e;}
      }
    });
  }
  private void read(Process launched) {
    try {
      InputStream input=launched.getInputStream();String header=RuntimeWire.readLine(input);
      if(header==null || !header.matches("OUTPOST_OWNER [1-9][0-9]{0,8}"))throw new IOException("PROCESS_OWNER");
      int pid=Integer.parseInt(header.substring(14));
      if(Os.stat("/proc/"+pid).st_uid!=android.os.Process.myUid())throw new IOException("PROCESS_UID");
      RuntimeWire channel=wire;
      submit(()->{if(process==launched)owner=pid;return null;}).get();
      if(channel==null)return;
      String line;
      while((line=RuntimeWire.readLine(input))!=null) {
        JSONObject frame=channel.decode(line);
        // One frame at a time: retain pipe backpressure instead of building an
        // unbounded executor backlog. Exit, stop and ready publish on one queue.
        submit(()->{acceptFrame(launched,frame);return null;}).get();
      }
    } catch(Exception e) {if(process==launched&&!stopping)stop("transport-lost",true);}
  }
  /** Called only by the commands queue; stop shares this monitor with publication. */
  private synchronized void acceptFrame(Process launched,JSONObject frame) throws Exception {
    if(process!=launched || stopping)return;
    String kind=frame.getString("kind");JSONObject payload=frame.getJSONObject("payload");
    if("ready".equals(kind)) {if(heartbeat!=0)throw new IOException("DUPLICATE_READY");heartbeat=SystemClock.elapsedRealtime();phase("running","authenticated-ready",false);}
    else if("heartbeat".equals(kind)) {
      if(heartbeat==0)throw new IOException("HEARTBEAT_BEFORE_READY");heartbeat=SystemClock.elapsedRealtime();
      activity=payload.getString("activity");if(!Arrays.asList("busy","waiting","idle").contains(activity))throw new IOException("RUNTIME_ACTIVITY");
      if("busy".equals(activity))idleSince=0;else if(idleSince==0)idleSince=heartbeat;
    }
    else if("response".equals(kind)) {CompletableFuture<JSONObject> promise=pending.remove(frame.getString("id"));if(promise!=null)promise.complete(payload);}
    else if("changed".equals(kind)) {journal.append("butler-changed",new JSONObject());changed();}
    else throw new IOException("UNSUPPORTED_RUNTIME_FRAME");
  }
  private void send(String kind,String id,JSONObject payload) throws Exception {
    synchronized(outputLock) {Process target=process;if(target==null)throw new IOException("RUNTIME_NOT_RUNNING");
      target.getOutputStream().write(wire.encode(kind,id,payload));target.getOutputStream().flush();}
  }
  /** Restricted transport only. Butler owns command validation, execution and receipts. */
  public CompletableFuture<JSONObject> request(String expectedGeneration,String operation,JSONObject args) {
    CompletableFuture<JSONObject> result=new CompletableFuture<>();
    if(!Arrays.asList("health","snapshot","tasks","task","capabilities","command","receipt","reconcile","memory","memory-history","memory-set","memory-delete").contains(operation)) {result.completeExceptionally(new IOException("OPERATION_NOT_ALLOWED"));return result;}
    final JSONObject requestArgs;
    try {
      // Capture this attempt before queueing; caller mutation cannot change a commandId.
      requestArgs=new JSONObject(args.toString());
      if("command".equals(operation) && !Objects.equals(expectedGeneration,requestArgs.opt("generation")))throw new IOException("STALE_RUNTIME");
    } catch(Exception e) {result.completeExceptionally(e);return result;}
    // Wire correlation is per attempt; the business commandId is forwarded unchanged.
    String id=UUID.randomUUID().toString();
    commands.execute(()->{try {
      if(!Objects.equals(generation,expectedGeneration)||stopping||!"running".equals(journal.snapshot().getString("phase")))throw new IOException("STALE_RUNTIME");
      if(pending.size()>=16)throw new IOException("BRIDGE_BUSY");
      pending.put(id,result);send("request",id,new JSONObject().put("op",operation).put("args",requestArgs));
      timers.schedule(()->{CompletableFuture<JSONObject> waiting=pending.remove(id);if(waiting!=null)waiting.completeExceptionally(new IOException("QUERY_TIMEOUT"));},7,TimeUnit.SECONDS);
    } catch(Exception e) {pending.remove(id);result.completeExceptionally(e);} });
    return result;
  }
  public void stop(String reason,boolean reconcile) {
    synchronized(this) {
      if(stopping)return;stopping=true;endReason=reason;
    }
    commands.execute(()->{try {
      Process target=process;
      if(target==null){
        boolean required=reconcile||journal.snapshot().optBoolean("requiresReconciliation");
        if(required){
          killStaleRuntimeProcesses();
          try{requireNoOtherAppProcess();}catch(Exception leftover){
            phase("stop-unconfirmed","stale-process-remains",true);finishService();return;
          }
        }
        phase(required?"interrupted":"stopped",reason,required);finishService();return;
      }
      try{phase("stopping",reason,reconcile);}catch(Exception journalFailure){endReason="journal-write-failed";}
      try{send("request",UUID.randomUUID().toString(),new JSONObject().put("op","shutdown").put("args",new JSONObject()));}catch(Exception ignored){}
      // Closing the private input is also the launcher's parent-loss/forced-cleanup signal.
      timers.schedule(()->{if(process==target)try{target.getOutputStream().close();}catch(Exception ignored){}},1500,TimeUnit.MILLISECONDS);
      timers.schedule(()->{if(process==target && target.isAlive()) {
        killOwner(OsConstants.SIGTERM);
      }},4,TimeUnit.SECONDS);
      // A stopped or SIGTERM-ignoring launcher must not wedge every later start.
      timers.schedule(()->{if(process==target && target.isAlive()) {
        killOwner(OsConstants.SIGKILL);
        target.destroyForcibly();
      }},7,TimeUnit.SECONDS);
      timers.schedule(()->{
        synchronized(RuntimeSupervisor.this){
          if(process!=target)return;
          killOwner(OsConstants.SIGKILL);
          target.destroyForcibly();
          for(CompletableFuture<JSONObject> waiter:pending.values())waiter.completeExceptionally(new IOException("RUNTIME_EXITED"));
          pending.clear();process=null;heartbeat=0;wire=null;
        }
        try{phase("stop-unconfirmed","process-cleanup-unconfirmed",true);}catch(Exception ignored){}
        finishService();
        stopping=false;
      },10,TimeUnit.SECONDS);
    } catch(Exception failure) {stopping=false;finishService();} finally {
      if(process==null)stopping=false;
    }});
  }
  /** Kill only the currently recorded launcher/owner group, never an arbitrary process. */
  private void killOwner(int signal) {
    int pid=owner;if(pid<=0)return;
    try{if(Os.stat("/proc/"+pid).st_uid==android.os.Process.myUid())Os.kill(-pid,signal);}catch(Exception ignored){}
    try{Os.kill(pid,signal);}catch(Exception ignored){}
  }
  /**
   * Remove only processes carrying this app's runtime entrypoint. A generic
   * same-UID helper is not a runtime orphan and must not block start/install or
   * be killed merely because the sharing app has no multi-process components.
   */
  private int killStaleRuntimeProcesses() {
    int uid=android.os.Process.myUid(),killed=0;
    File[] entries=new File("/proc").listFiles();if(entries==null)return 0;
    for(File entry:entries){
      String name=entry.getName();if(!name.matches("[0-9]+"))continue;
      int pid;try{pid=Integer.parseInt(name);}catch(NumberFormatException ignored){continue;}
      if(pid==android.os.Process.myPid())continue;
      try{if(Os.stat(entry.toString()).st_uid!=uid)continue;}catch(ErrnoException goneOrForeign){continue;}
      if(!isRuntimeProcess(pid))continue;
      try{if(processGroup(pid)==pid)Os.kill(-pid,OsConstants.SIGKILL);}catch(Exception ignored){}
      try{Os.kill(pid,OsConstants.SIGKILL);killed++;}catch(Exception ignored){}
    }
    return killed;
  }
  private static int processGroup(int pid) {
    try(FileInputStream input=new FileInputStream("/proc/"+pid+"/stat")){
      byte[] data=new byte[4096];int count=input.read(data);if(count<=0)return -1;
      String stat=new String(data,0,count,StandardCharsets.UTF_8);
      int end=stat.lastIndexOf(')');if(end<0)return -1;
      String[] fields=stat.substring(end+2).split(" ");
      return fields.length<3?-1:Integer.parseInt(fields[2]);
    }catch(Exception ignored){return -1;}
  }
  private static boolean isRuntimeProcess(int pid) {
    try(FileInputStream input=new FileInputStream("/proc/"+pid+"/cmdline")){
      byte[] data=new byte[4096];int count=input.read(data);if(count<=0)return false;
      String command=new String(data,0,count,StandardCharsets.UTF_8).replace('\0',' ');
      return command.contains("libdsh-runtime-runner.so")||command.contains("outpost-runtime/entry.mjs");
    }catch(Exception ignored){return false;}
  }
  private void waitForExit(Process launched) {
    try {
      int exit=launched.waitFor();
      // Publish exit and reconciliation on the same queue as start/stop. A new
      // start cannot observe a cleared process before the exit journal commits.
      commands.execute(()->finishExit(launched,exit));
    } catch(InterruptedException failure) { Thread.currentThread().interrupt();stop("exit-observation-failed",true); }
  }
  private void finishExit(Process launched,int exit) {
    try {
      synchronized(this) {
        if(process!=launched)return;
        // Signal/unknown launcher exits cannot attest that its subreaper cleanup ran.
        // A missing original group alone does not exclude a surviving separate session.
        boolean clean=exit>=0 && exit<125;
        if(owner>0)try{Os.kill(-owner,0);clean=false;}catch(ErrnoException error){if(error.errno!=OsConstants.ESRCH)clean=false;}
        try{requireNoOtherAppProcess();}catch(Exception unconfirmed){clean=false;}
        for(CompletableFuture<JSONObject> waiter:pending.values())waiter.completeExceptionally(new IOException("RUNTIME_EXITED"));pending.clear();
        process=null;heartbeat=0;wire=null;
        phase(!clean?"stop-unconfirmed":stopping?"stopped":"interrupted",
            !clean?"process-cleanup-unconfirmed":stopping?endReason:"unexpected-runtime-exit",true);
        stopping=false;finishService();
      }
    } catch(Exception failure) {stopping=false;try{phase("stop-unconfirmed","exit-observation-failed",true);}catch(Exception ignored){}finishService();}
  }
  private void finishService(){Runnable callback=stopped;if(callback!=null)main.post(callback);}
  private <T> CompletableFuture<T> submit(Callable<T> operation) {
    CompletableFuture<T> result=new CompletableFuture<>();commands.execute(()->{try{result.complete(operation.call());}catch(Exception e){result.completeExceptionally(e);}});return result;
  }
}
