# Faithful PyTorch re-implementation of TF Hub LEALLA-large/1 (the graph that produced the DB).
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
def gelu(x): return 0.5*x*(1+torch.tanh(0.7978846*(x+0.044715*x**3)))
class Lealla(nn.Module):
    def __init__(self, npz='tfvars.npz'):
        super().__init__()
        w=dict(np.load(npz)); self.w={k:torch.tensor(v) for k,v in w.items()}
    def g(self,k): return self.w['student_bert|'+k]
    def ln(self,x,p): 
        mu=x.mean(-1,keepdim=True); var=((x-mu)**2).mean(-1,keepdim=True)
        return (x-mu)*torch.rsqrt(var+1e-12)*self.g(p+'|gamma')+self.g(p+'|beta')
    def forward_embeds(self, word_emb, mask):
        B,T,_=word_emb.shape
        x=word_emb+self.g('embeddings|token_type_embeddings')[0]+self.g('embeddings|position_embeddings')[:T]
        return self.encode(self.ln(x,'embeddings|LayerNorm'), mask)
    def forward(self, ids, mask):
        return self.forward_embeds(self.g('embeddings|word_embeddings')[ids], mask)
    def encode(self, x, mask):
        B,T,H=x.shape; nh=8; hd=H//nh
        bias=((1.0-mask.float())*-10000.0)[:,None,None,:]
        for L in range(24):
            p=f'encoder|layer_{L}|'
            def lin(t,n): return t@self.g(p+n+'|kernel')+self.g(p+n+'|bias')
            q=lin(x,'attention|self|query').view(B,T,nh,hd).transpose(1,2)
            k=lin(x,'attention|self|key').view(B,T,nh,hd).transpose(1,2)
            v=lin(x,'attention|self|value').view(B,T,nh,hd).transpose(1,2)
            a=torch.softmax(q@k.transpose(-1,-2)*0.17677669+bias,-1)
            c=(a@v).transpose(1,2).reshape(B,T,H)
            x=self.ln(lin(c,'attention|output|dense')+x, p+'attention|output|LayerNorm')
            h=gelu(lin(x,'intermediate|dense'))
            x=self.ln(lin(h,'output|dense')+x, p+'output|LayerNorm')
        pooled=gelu(x[:,0]@self.g('pooler|dense|kernel')+self.g('pooler|dense|bias'))
        return F.normalize(pooled,dim=-1)
