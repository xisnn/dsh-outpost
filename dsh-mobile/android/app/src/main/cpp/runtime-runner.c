#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Private pipe + one launch session + subreaper. Cleanup includes adopted children
 * in other process groups (for example PTY children). Not a hostile-code sandbox. */
static volatile sig_atomic_t stopping;
static void request_stop(int sig) { (void)sig;stopping=1; }
static long long now_ms(void) { struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
/* Only direct children of this owner are signalled here. Reparenting after an
 * ancestor exits is handled by PR_SET_CHILD_SUBREAPER and repeated reap passes. */
static void signal_adopted(int sig) {
  DIR *proc=opendir("/proc");if(!proc)return;struct dirent *entry;
  while((entry=readdir(proc))!=NULL) {
    char *end;long pid=strtol(entry->d_name,&end,10);if(*end || pid<=0 || pid==getpid())continue;
    char filename[96];snprintf(filename,sizeof(filename),"/proc/%ld/stat",pid);
    struct stat info;if(stat(filename,&info)<0 || info.st_uid!=getuid())continue;
    FILE *file=fopen(filename,"r");if(!file)continue;char text[4096];char *read=fgets(text,sizeof(text),file);fclose(file);if(!read)continue;
    char *close=strrchr(text,')');char state;int parent;
    if(close && sscanf(close+2,"%c %d",&state,&parent)==2 && parent==getpid())kill((pid_t)pid,sig);
  }
  closedir(proc);
}
int main(int argc,char **argv) {
  if(argc<2 || argv[1][0]!='/')return 64;
  pid_t app_parent=getppid();if(setsid()<0)return 70;
  struct sigaction sa;memset(&sa,0,sizeof(sa));sa.sa_handler=request_stop;sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM,&sa,NULL);sigaction(SIGINT,&sa,NULL);signal(SIGPIPE,SIG_IGN);
  if(prctl(PR_SET_PDEATHSIG,SIGTERM)<0 || getppid()!=app_parent)return 71;
  if(prctl(PR_SET_CHILD_SUBREAPER,1)<0)return 72;
  int input[2];if(pipe(input)<0)return 73;
  printf("OUTPOST_OWNER %d\n",getpid());fflush(stdout);
  pid_t child=fork();if(child<0)return 74;
  if(child==0) {
    signal(SIGTERM,SIG_DFL);signal(SIGINT,SIG_DFL);signal(SIGPIPE,SIG_DFL);
    close(input[1]);if(dup2(input[0],STDIN_FILENO)<0)_exit(75);close(input[0]);execv(argv[1],&argv[1]);_exit(127);
  }
  close(input[0]);fcntl(input[1],F_SETFL,fcntl(input[1],F_GETFL)|O_NONBLOCK);
  int status=0,root_exited=0;
  while(!stopping) {
    if(waitpid(child,&status,WNOHANG)==child){root_exited=1;break;}
    struct pollfd pfd={STDIN_FILENO,POLLIN|POLLHUP,0};int polled=poll(&pfd,1,100);
    if(polled<0 && errno!=EINTR)break;
    if(polled>0 && (pfd.revents&(POLLIN|POLLHUP|POLLERR))) {
      char data[4096];ssize_t got=read(STDIN_FILENO,data,sizeof(data));if(got<=0)break;
      ssize_t at=0;long long deadline=now_ms()+3000;
      while(at<got && !stopping) {
        ssize_t n=write(input[1],data+at,(size_t)(got-at));
        if(n<0 && (errno==EINTR || errno==EAGAIN)) {
          if(now_ms()>deadline){stopping=1;break;}
          struct pollfd writable={input[1],POLLOUT,0};poll(&writable,1,50);continue;
        }
        if(n<=0){stopping=1;break;}at+=n;
      }
    }
  }
  close(input[1]);kill(-getpgrp(),SIGTERM);
  long long began=now_ms();int remaining=1;
  while(now_ms()-began<2500) {
    int sig=now_ms()-began<700?SIGTERM:SIGKILL;
    signal_adopted(sig);
    pid_t reaped;
    do { reaped=waitpid(-1,NULL,WNOHANG); } while(reaped>0);
    if(reaped<0 && errno==ECHILD){remaining=0;break;}
    struct timespec t={0,20000000};nanosleep(&t,NULL);
  }
  if(remaining)return 125; /* Native must not claim a verified stop in this case. */
  return root_exited && WIFEXITED(status)?WEXITSTATUS(status):0;
}
