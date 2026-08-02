# 📱 Flutter Setup Guide: Viewing & Streaming

Welcome to the Shiv Shakti Image Server Flutter documentation. 

**IMPORTANT NOTE:** Mobile applications (like Flutter apps) are currently supported for **Streaming and Viewing only**. Uploading files directly from the mobile app is not supported by the default security model (you should handle uploads via your own secure backend server).

---

## 1. Authentication Setup
Since mobile apps do not run on a standard web domain, the server's "Referer Check" will reject your requests. 
To authenticate, you **MUST** pass your Web Connection's `Security Key` directly in the URL as a query parameter.

**The Base URL Format:**
```dart
final mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";
```

## 2. Viewing Images (Image.network)
You can easily load secure images using Flutter's built-in `Image.network` widget, or use caching libraries like `cached_network_image`.

```dart
import 'package:flutter/material.dart';

class SecureImageViewer extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";
    
    return Image.network(
      mediaUrl,
      loadingBuilder: (context, child, loadingProgress) {
        if (loadingProgress == null) return child;
        return const CircularProgressIndicator();
      },
    );
  }
}
```

## 3. Streaming Videos (video_player)
The server fully supports **HTTP Range Requests**. When you pass the media URL to the `video_player` package, it will automatically request the video in small chunks (buffering roughly 30 seconds at a time) instead of trying to download the entire video at once. This prevents crashes and starts playback instantly!

```dart
import 'package:video_player/video_player.dart';

// Initialize your VideoPlayerController:
final mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";
late VideoPlayerController _controller;

@override
void initState() {
  super.initState();
  _controller = VideoPlayerController.networkUrl(Uri.parse(mediaUrl))
    ..initialize().then((_) {
      setState(() {});
      _controller.play();
    });
}
```
*Note: The `video_player` package handles chunked HTTP Range streaming natively in the background!*

## 4. Viewing PDFs (syncfusion_flutter_pdfviewer)
You can embed PDFs securely inside your app using a dedicated PDF rendering package.

```dart
import 'package:syncfusion_flutter_pdfviewer/pdfviewer.dart';

class SecurePdfViewer extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";
    
    return SfPdfViewer.network(mediaUrl);
  }
}
```
