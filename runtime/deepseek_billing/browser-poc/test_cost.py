import unittest
from verify_cost import run, LIVES

class CostTests(unittest.TestCase):
    def fixtures(self):
        keys=['sk-aaaaa'+'c'*23+'bbbb','sk-ddddd'+'e'*23+'ffff']
        ids=['45ddc811-9255-587e-aeb7-b66f34ea8edc','253abb69-1ffc-52a9-910d-0e11873933d3']
        rows=[]
        for i,name in enumerate(['persona','new digital life']):
            identity={'tracking_id':ids[i],'name':name,'sensitive_id':keys[i][:8]+'*'*23+keys[i][-4:]}
            for model,cost in [('model_a','0.1234567890123456789'),('model_b','0.0000000000000000001')]:
                rows.append({'api_key':identity,'model':model,'buckets':[{'time':100,'cost':cost}]})
        def operation(action,ref):
            return {'value':keys[0 if next(iter(LIVES))[5:].replace('-','_').upper() in ref else 1]}
        return {'series':rows,'start':100,'end':200},operation,keys

    def test_multiple_models_exact_decimal_and_no_secret_output(self):
        value,operation,keys=self.fixtures();result=run(value,operation)
        self.assertEqual([x['today_cost_cny'] for x in result['lives']],['0.1234567890123456790']*2)
        self.assertEqual([x['official_ui_display_cny'] for x in result['lives']],['0.12']*2)
        for key in keys:self.assertNotIn(key,str(result))

    def test_duplicate_series_rejected(self):
        value,operation,_=self.fixtures();value['series'].append(value['series'][0])
        with self.assertRaises(ValueError):run(value,operation)

    def test_no_account_total_fallback_for_missing_key(self):
        value,operation,_=self.fixtures();value['series']=value['series'][:2]
        with self.assertRaises(ValueError):run(value,operation)

    def test_outside_window_cost_rejected(self):
        value,operation,_=self.fixtures();value['series'][0]['buckets'][0]['time']=200
        with self.assertRaises(ValueError):run(value,operation)

if __name__=='__main__':unittest.main()
