package com.operator.bridge.net

import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

data class HotspotSubnet(
    val iface: String,
    val localIp: String,
    val prefix: Int,
    val broadcast: String?,
    val hosts: List<String>,
)

data class DiscoveryTargets(
    val subnets: List<HotspotSubnet>,
    val broadcasts: List<String>,
    val neighbors: List<String>,
    val summary: String,
)

object HotspotNetworkFinder {
    private val hotspotNames = listOf("ap", "wlan", "swlan", "softap", "rndis", "p2p", "wifi")

    fun scan(): DiscoveryTargets {
        val subnets = mutableListOf<HotspotSubnet>()
        val notes = mutableListOf<String>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            for (iface in interfaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (address in iface.interfaceAddresses) {
                    val inet = address.address
                    if (inet !is Inet4Address || inet.isLoopbackAddress) continue
                    val ip = inet.hostAddress ?: continue
                    val prefix = address.networkPrefixLength.toInt()
                    if (!isPrivate(ip)) {
                        notes += "${iface.name} $ip/$prefix public"
                        continue
                    }
                    if (prefix < 24 || prefix > 30) {
                        notes += "${iface.name} $ip/$prefix skipped (not a small LAN)"
                        continue
                    }
                    val broadcast = address.broadcast?.hostAddress
                    val hosts = hostsInPrefix(ip, prefix)
                    subnets += HotspotSubnet(iface.name, ip, prefix, broadcast, hosts)
                    notes += "${iface.name} $ip/$prefix broadcast=${broadcast ?: "none"} sweep=${hosts.size}"
                }
            }
        } catch (error: Exception) {
            notes += "interface scan failed: ${error.javaClass.simpleName}"
        }
        val preferred = subnets.sortedByDescending { score(it) }
        val neighbors = readNeighbors()
        val broadcasts = buildList {
            add("255.255.255.255")
            preferred.mapNotNull { it.broadcast }.forEach { add(it) }
        }.distinct()
        if (preferred.isEmpty()) notes += "no private hotspot subnet found"
        if (neighbors.isEmpty()) notes += "neighbor table empty or blocked"
        else notes += "neighbors ${neighbors.joinToString(",")}"
        return DiscoveryTargets(preferred, broadcasts, neighbors, notes.joinToString(" | "))
    }

    fun score(subnet: HotspotSubnet): Int {
        var value = 0
        val name = subnet.iface.lowercase()
        if (hotspotNames.any { name.contains(it) }) value += 20
        if (name.contains("ap") || name.contains("swlan") || name.contains("rndis")) value += 30
        if (subnet.localIp.endsWith(".1")) value += 25
        if (subnet.localIp.startsWith("192.168.43.") || subnet.localIp.startsWith("192.168.12.")) value += 10
        return value
    }

    private fun hostsInPrefix(ip: String, prefix: Int): List<String> {
        val parts = ip.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return emptyList()
        val hostBits = 32 - prefix
        val count = (1 shl hostBits) - 2
        if (count <= 0 || count > 254) return emptyList()
        val base = ((parts[0] shl 24) or (parts[1] shl 16) or (parts[2] shl 8) or parts[3]) and (-1 shl hostBits)
        val own = (parts[0] shl 24) or (parts[1] shl 16) or (parts[2] shl 8) or parts[3]
        val out = ArrayList<String>(count)
        for (offset in 1..count) {
            val value = base + offset
            if (value == own) continue
            out += "${(value ushr 24) and 255}.${(value ushr 16) and 255}.${(value ushr 8) and 255}.${value and 255}"
        }
        return out
    }

    private fun readNeighbors(): List<String> {
        val found = linkedSetOf<String>()
        found += parseNeighbor(readCommand(arrayOf("ip", "neigh")))
        found += parseNeighbor(readText(File("/proc/net/arp")))
        return found.filter { isPrivate(it) }
    }

    private fun parseNeighbor(text: String): List<String> {
        val ips = Regex("""\b(?:\d{1,3}\.){3}\d{1,3}\b""").findAll(text).map { it.value }.toList()
        return ips.filter { isPrivate(it) && !it.endsWith(".0") && !it.endsWith(".255") }
    }

    private fun readCommand(cmd: Array<String>): String {
        return try {
            val process = ProcessBuilder(*cmd).redirectErrorStream(true).start()
            val text = process.inputStream.bufferedReader().use { it.readText() }
            process.waitFor()
            text
        } catch (_: Exception) {
            ""
        }
    }

    private fun readText(file: File): String {
        return try {
            if (file.canRead()) file.readText() else ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun isPrivate(ip: String): Boolean {
        val parts = ip.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        val a = parts[0]
        val b = parts[1]
        return a == 10 || a == 192 && b == 168 || a == 172 && b in 16..31
    }

    fun reachable(ip: String): Boolean = isPrivate(ip)
}
