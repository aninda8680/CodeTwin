/// Decision card for AWAITING_APPROVAL messages.
///
/// Shows the question, optional buttons, optional free-text input,
/// and a countdown timer if timeoutMs is set.

import 'dart:async';
import 'package:flutter/material.dart';
import '../models/log_entry.dart';
import '../theme/cli_theme.dart';

class DecisionCard extends StatefulWidget {
  final DecisionItem item;
  final void Function(String awaitingResponseId, String answer) onAnswer;
  final void Function(String awaitingResponseId) onReject;
  final bool inChat;

  const DecisionCard({
    super.key,
    required this.item,
    required this.onAnswer,
    required this.onReject,
    this.inChat = false,
  });

  @override
  State<DecisionCard> createState() => _DecisionCardState();
}

class _DecisionCardState extends State<DecisionCard> {
  final _textController = TextEditingController();
  Timer? _countdownTimer;
  int _remainingMs = 0;

  @override
  void initState() {
    super.initState();
    if (widget.item.timeoutMs != null && widget.item.timeoutMs! > 0) {
      _remainingMs = widget.item.timeoutMs!;
      _countdownTimer = Timer.periodic(
        const Duration(seconds: 1),
        (_) {
          setState(() {
            _remainingMs -= 1000;
            if (_remainingMs <= 0) {
              _countdownTimer?.cancel();
              widget.onReject(widget.item.awaitingResponseId);
            }
          });
        },
      );
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _textController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cli = CliTheme.of(context);
    final hasOptions =
        widget.item.options != null && widget.item.options!.isNotEmpty;

    return Container(
      decoration: cli.box(
        borderColor: cli.cyan,
        bgColor: cli.surface,
        radius: 12,
      ),
      padding: EdgeInsets.all(widget.inChat ? 12 : 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.help_outline, size: 16, color: cli.cyan),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'DECISION REQUIRED',
                  style: cli.mono.copyWith(
                    color: cli.cyan,
                    fontSize: 10,
                    letterSpacing: 1.2,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              if (_remainingMs > 0)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: cli.redMuted,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: cli.red.withValues(alpha: 0.6)),
                  ),
                  child: Text(
                    '${(_remainingMs / 1000).ceil()}s',
                    style: cli.mono.copyWith(
                      color: cli.red,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            widget.item.question,
            style: cli.mono.copyWith(
              color: cli.text,
              fontSize: widget.inChat ? 13 : 14,
              height: 1.35,
            ),
          ),
          const SizedBox(height: 12),
          if (hasOptions)
            ...widget.item.options!.asMap().entries.map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      side: BorderSide(color: cli.border),
                      foregroundColor: cli.text,
                      backgroundColor: cli.bg,
                      alignment: Alignment.centerLeft,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                    ),
                    onPressed: () => widget.onAnswer(
                      widget.item.awaitingResponseId,
                      e.value,
                    ),
                    child: Text(
                      '${e.key + 1}. ${e.value}',
                      style: cli.mono.copyWith(
                        color: cli.text,
                        fontSize: 12,
                      ),
                    ),
                  ),
                )),
          Text(
            hasOptions ? 'Or send a custom answer:' : 'Send a custom answer:',
            style: cli.mono.copyWith(
              color: cli.textDim,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _textController,
            style: cli.mono.copyWith(color: cli.text, fontSize: 13),
            cursorColor: cli.accent,
            decoration: InputDecoration(
              hintText: 'Type your answer...',
              hintStyle: cli.mono.copyWith(color: cli.textDim, fontSize: 12),
              filled: true,
              fillColor: cli.bg,
              isDense: true,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide(color: cli.border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide(color: cli.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: BorderSide(color: cli.accent),
              ),
            ),
            maxLines: 2,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    side: BorderSide(color: cli.red.withValues(alpha: 0.6)),
                    foregroundColor: cli.red,
                    padding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onPressed: () => widget.onReject(widget.item.awaitingResponseId),
                  child: Text(
                    'Reject',
                    style: cli.mono.copyWith(
                      color: cli.red,
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: cli.accent,
                    foregroundColor: cli.bg,
                    padding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onPressed: () {
                    final text = _textController.text.trim();
                    if (text.isNotEmpty) {
                      widget.onAnswer(widget.item.awaitingResponseId, text);
                    }
                  },
                  child: Text(
                    'Send',
                    style: cli.mono.copyWith(
                      color: cli.bg,
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
