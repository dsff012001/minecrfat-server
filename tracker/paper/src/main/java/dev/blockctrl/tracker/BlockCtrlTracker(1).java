package dev.blockctrl.tracker;

import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Item;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.ItemDespawnEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.UUID;

public final class BlockCtrlTracker extends JavaPlugin implements Listener {
  private NamespacedKey ownerId, ownerName; private String serverId; private final HttpClient client=HttpClient.newHttpClient();
  @Override public void onEnable(){saveDefaultConfig();serverId=getConfig().getString("server-id","");ownerId=new NamespacedKey(this,"owner_uuid");ownerName=new NamespacedKey(this,"owner_name");getServer().getPluginManager().registerEvents(this,this);}
  @EventHandler public void onDrop(PlayerDropItemEvent e){Item item=e.getItemDrop();item.getPersistentDataContainer().set(ownerId,PersistentDataType.STRING,e.getPlayer().getUniqueId().toString());item.getPersistentDataContainer().set(ownerName,PersistentDataType.STRING,e.getPlayer().getName());}
  @EventHandler public void onDeath(PlayerDeathEvent e){if(e.getKeepInventory())return;Location l=e.getEntity().getLocation();for(ItemStack stack:e.getDrops())sendStack(stack,l,e.getEntity().getUniqueId().toString(),e.getEntity().getName(),"death");}
  @EventHandler public void onDespawn(ItemDespawnEvent e){send(e.getEntity(),"despawn");}
  @EventHandler public void onDamage(EntityDamageEvent e){if(!(e.getEntity() instanceof Item item))return;String reason=switch(e.getCause()){case LAVA->"lava";case FIRE,FIRE_TICK->"fire";case CONTACT->"cactus";case BLOCK_EXPLOSION,ENTITY_EXPLOSION->"explosion";case VOID->"void";default->null;};if(reason!=null)getServer().getScheduler().runTask(this,()->{if(!item.isValid()||item.isDead())send(item,reason);});}
  private void send(Item entity,String reason){sendStack(entity.getItemStack(),entity.getLocation(),entity.getPersistentDataContainer().get(ownerId,PersistentDataType.STRING),entity.getPersistentDataContainer().get(ownerName,PersistentDataType.STRING),reason);}
  private void sendStack(ItemStack stack,Location l,String pId,String pName,String reason){String json="{\"eventId\":\""+UUID.randomUUID()+"\",\"playerUuid\":"+q(pId)+",\"playerName\":"+q(pName)+",\"itemId\":"+q(stack.getType().getKey().toString())+",\"itemName\":"+q(stack.getType().translationKey())+",\"amount\":"+stack.getAmount()+",\"reason\":"+q(reason)+",\"world\":"+q(l.getWorld().getName())+",\"x\":"+l.getBlockX()+",\"y\":"+l.getBlockY()+",\"z\":"+l.getBlockZ()+",\"occurredAt\":"+q(Instant.now().toString())+",\"metadata\":{}}";HttpRequest req=HttpRequest.newBuilder(URI.create("http://127.0.0.1:8788/item-loss")).header("content-type","application/json").header("x-blockctrl-server-id",serverId).POST(HttpRequest.BodyPublishers.ofString(json)).build();client.sendAsync(req,HttpResponse.BodyHandlers.discarding()).exceptionally(ex->{getLogger().warning("Item loss could not be queued: "+ex.getMessage());return null;});}
  private static String q(String v){return v==null?"null":"\""+v.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
}
