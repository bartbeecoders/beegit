In the scion folder is an implementation of anthropics scion git system. I want to make it my own. (apache 2.0 license)
Create in the root folder /run/media/bart/Development/dev/bartbeecoders/BeeGit an implementation that we call BeeGit.

Idea is to be able to run and test it locally and later deploy it to our VPS server (ssh bart@212.47.77.32) - this runs a K3S

Recreate it with clear documentation, and with a plan/task (in html) with improvements (you can add some, I will add some later)


TO deploy to the vps (K3s), I added an example script from another project in /run/media/bart/Development/dev/bartbeecoders/BeeGit/scripts/deploy-k3s.sh
I use cloudflare tunnels to expose the website. (I can use beegit.hideterms.com) Use internal ports 32100 and up

Improve the plan by adding a web front end to the git repo. I want to have a full web overview of the repos, files, commits, logs etc