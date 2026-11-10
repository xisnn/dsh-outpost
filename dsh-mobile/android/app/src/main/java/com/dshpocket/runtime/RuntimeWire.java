package com.dshpocket.runtime;

import android.util.Base64;
import org.json.JSONObject;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Private inherited pipes: no listening TCP port, secret never crosses the RN bridge. */
public final class RuntimeWire {
  public static final int MAX_LINE=262144;
  private final String generation;
  private final byte[] key;
  private long sent, received;
  public RuntimeWire(String generation,byte[] key) { this.generation=generation;this.key=key.clone(); }
  private byte[] sign(long n,String kind,String id,String payload) throws Exception {
    Mac mac=Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key,"HmacSHA256"));
    return mac.doFinal(("1\n"+generation+"\n"+n+"\n"+kind+"\n"+id+"\n"+payload).getBytes(StandardCharsets.UTF_8));
  }
  public synchronized byte[] encode(String kind,String id,JSONObject payload) throws Exception {
    if(!kind.matches("[a-z.]{1,32}") || !id.matches("[a-zA-Z0-9-]{0,64}")) throw new IOException("WIRE_FIELDS");
    if(sent>=9007199254740990L) throw new IOException("WIRE_EXHAUSTED");
    long n=sent+1; String data=Base64.encodeToString(payload.toString().getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP);
    byte[] bytes=(new JSONObject().put("v",1).put("generation",generation).put("n",n).put("kind",kind).put("id",id)
        .put("payload",data).put("mac",Base64.encodeToString(sign(n,kind,id,data),Base64.NO_WRAP)).toString()+"\n").getBytes(StandardCharsets.UTF_8);
    if(bytes.length>MAX_LINE) throw new IOException("WIRE_SIZE");
    sent=n;
    return bytes;
  }
  public synchronized JSONObject decode(String line) throws Exception {
    if(line.length()>MAX_LINE) throw new IOException("WIRE_SIZE");
    JSONObject frame=new JSONObject(line); long n=frame.getLong("n");
    String kind=frame.getString("kind"),id=frame.getString("id"),data=frame.getString("payload");
    if(frame.getInt("v")!=1 || !generation.equals(frame.getString("generation")) || n!=received+1 ||
        !kind.matches("[a-z.]{1,32}") || !id.matches("[a-zA-Z0-9-]{0,64}")) throw new IOException("WIRE_IDENTITY");
    if(!MessageDigest.isEqual(sign(n,kind,id,data),Base64.decode(frame.getString("mac"),Base64.NO_WRAP))) throw new IOException("WIRE_AUTH");
    JSONObject payload=new JSONObject(new String(Base64.decode(data,Base64.NO_WRAP),StandardCharsets.UTF_8));
    received=n;
    return new JSONObject().put("kind",kind).put("id",id).put("payload",payload);
  }
  public static String readLine(InputStream input) throws IOException {
    ByteArrayOutputStream out=new ByteArrayOutputStream(); int b;
    while((b=input.read())!=-1) {
      if(b=='\n') return out.toString("UTF-8");
      if(out.size()>=MAX_LINE) throw new IOException("WIRE_SIZE"); out.write(b);
    }
    if(out.size()!=0) throw new EOFException("WIRE_TRUNCATED");
    return null;
  }
}
