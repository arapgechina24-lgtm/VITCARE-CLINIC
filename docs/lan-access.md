# Reaching the systems from other computers

Both apps run on the Mac at the pharmacy. Every other computer on the clinic
WiFi opens them in a browser — nothing to install.

## Use the hostname, not the IP

```
Pharmacy till    http://araps-macbook-pro.local:3000
Clinic / EMR     http://araps-macbook-pro.local:3001
```

**Bookmark these, not `192.168.100.123`.** The Mac gets its address from the
router by DHCP, so that number changes on a lease renewal or a router reboot —
and every bookmark pointing at it breaks at once, on a morning when nobody
knows why. The `.local` name is advertised by the Mac itself over mDNS
(Bonjour) and follows it to whatever address it lands on. Verified: both apps
answer 200 on the hostname.

Supported natively by macOS, iOS, Android, and Windows 10 (1703+). If an old
Windows PC cannot resolve it, that machine — and only that machine — can fall
back to the IP, which is why the reservation below is still worth doing.

## The DHCP reservation, and the trap in it

A reservation pins the Mac to one address on the router at
`192.168.100.1` → DHCP / LAN settings → Address Reservation.

**Reserve the HARDWARE MAC, not the one the router is showing you today:**

```
hardware MAC   38:f9:d3:c7:f3:09     <- use this
currently in use   06:34:0a:54:c2:c2 <- randomised, will change
```

macOS **Private Wi-Fi Address** is on for this network, so the Mac presents a
randomised MAC. That feature exists to stop shops and airports tracking a
laptop across public networks; on the clinic's own WiFi it does the opposite of
what you want, because it makes the one device that must be findable
deliberately unrecognisable. A reservation keyed to the randomised address
holds until it rotates — which happens when the network is forgotten and
rejoined — and then fails silently.

Turn it off first:

**System Settings → Wi-Fi → (i) next to the clinic network → Private Wi-Fi
Address → Off**, then rejoin. The router will then see `38:f9:d3:c7:f3:09`,
which never changes. Reserve that.

## What does NOT depend on any of this

The clinic and the till talk to each other over `localhost`, because both run
on the same Mac:

```
clinic -> till   http://localhost:3000/api
till -> clinic   http://localhost:3001/api/integration/pos/prescription-status
```

So a DHCP change cannot break prescription delivery. It only breaks other
people's bookmarks. (An earlier version of this setup used LAN IPs for the
integration, where a lease change *would* have broken it silently — that is no
longer the case.)

If the clinic ever moves to its own machine, these become that machine's
reserved address or `.local` name, and the DHCP reservation stops being
cosmetic and starts being load-bearing.

## A nicer name (optional)

`araps-macbook-pro.local` works but reads like a personal laptop. To make it
obvious what the machine is:

```
sudo scutil --set LocalHostName vitcare
sudo scutil --set ComputerName "Vitcare Server"
```

The addresses then become `http://vitcare.local:3000` and `:3001`. Do this
*before* printing bookmarks for staff — changing it afterwards breaks them all.

## Security note

This traffic is plain HTTP over shared WiFi. The HMAC on the integration proves
who sent a prescription; it does not hide the patient's name or drugs from
anyone else on the network. Until LAN HTTPS is in place, the clinical WiFi
should have its own password and not be shared with patients. See
`deploy/cloudflare/README.md`.
