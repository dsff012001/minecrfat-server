package dev.blockctrl.tracker;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;

@Mod("blockctrl_tracker")
public final class BlockCtrlNeoForge {
  private static final Gson GSON = new Gson();
  private static final HttpClient HTTP = HttpClient.newHttpClient();
  private static final Map<UUID, Owner> OWNERS = new ConcurrentHashMap<>();
  private static String serverId = "";

  public BlockCtrlNeoForge(IEventBus modBus) {
    modBus.addListener(this::setup);
    NeoForge.EVENT_BUS.register(this);
  }

  private void setup(FMLCommonSetupEvent event) {
    serverId = System.getProperty("blockctrl.server-id", System.getenv().getOrDefault("BLOCKCTRL_SERVER_ID", ""));
  }

  @net.neoforged.bus.api.SubscribeEvent
  public void onPlayerDrop(PlayerEvent.ItemPickupEvent ignored) { }

  @net.neoforged.bus.api.SubscribeEvent
  public void onJoin(EntityJoinLevelEvent event) {
    if (!(event.getEntity() instanceof ItemEntity item)) return;
    if (item.getThrower() != null) {
      Player player = event.getLevel().getPlayerByUUID(item.getThrower());
      if (player != null) OWNERS.put(item.getUUID(), new Owner(player.getUUID().toString(), player.getName().getString()));
    }
  }

  @net.neoforged.bus.api.SubscribeEvent
  public void onDeath(LivingDeathEvent event) {
    if (!(event.getEntity() instanceof Player player)) return;
    if (player.getInventory().isEmpty()) return;
    Vec3 pos = player.position();
    for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
      ItemStack stack = player.getInventory().getItem(slot);
      if (!stack.isEmpty()) send(stack, pos, player.getUUID().toString(), player.getName().getString(), "death", player.level());
    }
  }

  private void send(ItemStack stack, Vec3 pos, String playerUuid, String playerName, String reason, Level level) {
    if (serverId.isBlank()) return;
    JsonObject item = new JsonObject();
    item.addProperty("eventId", UUID.randomUUID().toString());
    item.addProperty("playerUuid", playerUuid); item.addProperty("playerName", playerName);
    item.addProperty("itemId", stack.getItem().builtInRegistryHolder().key().location().toString());
    item.addProperty("itemName", stack.getHoverName().getString()); item.addProperty("amount", stack.getCount());
    item.addProperty("reason", reason); item.addProperty("world", level.dimension().location().toString());
    item.addProperty("x", (int) pos.x); item.addProperty("y", (int) pos.y); item.addProperty("z", (int) pos.z);
    item.addProperty("occurredAt", Instant.now().toString()); item.add("metadata", GSON.toJsonTree(Map.of()));
    HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:8788/item-loss"))
      .header("content-type", "application/json").header("x-blockctrl-server-id", serverId)
      .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(item))).build();
    HTTP.sendAsync(request, HttpResponse.BodyHandlers.discarding());
  }

  private record Owner(String uuid, String name) { }
}
