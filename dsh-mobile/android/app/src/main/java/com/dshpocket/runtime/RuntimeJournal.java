package com.dshpocket.runtime;

import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Native transport/lifecycle state only. DSH/Butler remain the business state authority. */
public final class RuntimeJournal {
  private final AtomicFile file;
  private JSONObject state;
  private final JSONArray events = new JSONArray();
  private long sequence;
  public RuntimeJournal(File directory) throws Exception {
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("JOURNAL_DIRECTORY");
    file = new AtomicFile(new File(directory, "state.json"));
    if (file.getBaseFile().exists() || new File(file.getBaseFile()+".bak").exists()) {
      try (InputStream in = file.openRead()) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int n;
        while ((n=in.read(buffer))!=-1) { if(out.size()+n>262144) throw new IOException("JOURNAL_SIZE"); out.write(buffer,0,n); }
        JSONObject saved = new JSONObject(out.toString("UTF-8"));
        if(saved.getInt("schema")!=1) throw new IOException("JOURNAL_SCHEMA");
        state = saved.getJSONObject("state"); sequence = saved.getLong("sequence");
        if(sequence<0) throw new IOException("JOURNAL_CURSOR");
        JSONArray old=saved.getJSONArray("events");
        for(int i=Math.max(0,old.length()-128);i<old.length();i++) events.put(old.getJSONObject(i));
      }
      if (!"stopped".equals(state.getString("phase"))) transition("interrupted", "app-restarted", true);
    } else {
      state=new JSONObject().put("phase","stopped").put("generation",JSONObject.NULL)
          .put("requiresReconciliation",false).put("reason","never-started");
      save();
    }
  }
  private void save() throws Exception {
    byte[] bytes = new JSONObject().put("schema",1).put("sequence",sequence)
        .put("state",state).put("events",events).toString().getBytes(StandardCharsets.UTF_8);
    FileOutputStream stream=file.startWrite();
    try { stream.write(bytes); stream.getFD().sync(); file.finishWrite(stream); }
    catch(Exception e) { file.failWrite(stream); throw e; }
    // AtomicFile.finishWrite logs some rename failures instead of throwing.
    try(InputStream in=file.openRead()) {
      ByteArrayOutputStream actual=new ByteArrayOutputStream();byte[] block=new byte[4096];int n;
      while((n=in.read(block))!=-1){if(actual.size()+n>262144)throw new IOException("JOURNAL_SIZE");actual.write(block,0,n);}
      if(!Arrays.equals(bytes,actual.toByteArray()))throw new IOException("JOURNAL_COMMIT_NOT_CONFIRMED");
    }
  }
  public synchronized JSONObject snapshot() throws Exception {
    return new JSONObject(state.toString()).put("cursor",sequence).put("observedAt",System.currentTimeMillis());
  }
  public synchronized void begin(String generation) throws Exception {
    state.put("generation",generation); transition("starting","user-started",false);
  }
  public synchronized void transition(String phase,String reason,boolean reconcile) throws Exception {
    state.put("phase",phase).put("reason",reason).put("requiresReconciliation",reconcile)
        .put("changedAt",System.currentTimeMillis());
    append("lifecycle",new JSONObject().put("phase",phase).put("reason",reason));
  }
  public synchronized void append(String kind, JSONObject detail) throws Exception {
    if(sequence>=9007199254740990L) throw new IOException("JOURNAL_CURSOR_EXHAUSTED");
    sequence++;
    if(events.length()==128) events.remove(0);
    events.put(new JSONObject().put("cursor",sequence).put("kind",kind).put("generation",state.opt("generation"))
        .put("time",System.currentTimeMillis()).put("detail",detail));
    save();
  }
  public synchronized JSONObject read(long after) throws Exception {
    if(after<0) throw new IOException("INVALID_CURSOR");
    long oldest=events.length()==0?sequence+1:events.getJSONObject(0).getLong("cursor");
    JSONArray batch=new JSONArray();
    for(int i=0;i<events.length();i++) if(events.getJSONObject(i).getLong("cursor")>after) batch.put(events.get(i));
    return new JSONObject().put("snapshot",snapshot()).put("events",batch)
        .put("gap",after>sequence || after<oldest-1).put("cursor",sequence);
  }
}
