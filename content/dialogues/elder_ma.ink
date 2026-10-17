VAR met_elder = false

-> start

=== start ===
马婆婆：旅人，你来得正好。翠谷的史莱姆最近躁动得厉害。
~ met_elder = true
* [发生了什么？]
    马婆婆：它们从溪边涌出来，已经伤了好几个采药人。
    -> offer
* [我这就去。]
    -> offer

=== offer ===
# quest:offer:quest:cull_slimes
马婆婆：帮我们清理三只史莱姆吧。完成后回来找我，我把旅人短剑给你。
-> END

=== turn_in ===
# quest:turnin:quest:cull_slimes
马婆婆：你真的做到了！这是说好的报酬。
-> END
