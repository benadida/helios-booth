
//
// Helios Protocols
// 
// ben@adida.net
//
// FIXME: needs a healthy refactor/cleanup based on Class.extend()
//

// extend jquery to do object keys
// from http://snipplr.com/view.php?codeview&id=10430
$.extend({
    keys: function(obj){
        var a = [];
        $.each(obj, function(k){ a.push(k) });
        return a.sort();
    }
});

var UTILS = {};

UTILS.array_remove_value = function(arr, val) {
  var new_arr = [];
  $(arr).each(function(i, v) {
    if (v != val) {
	new_arr.push(v);
    }
  });

  return new_arr;
};

UTILS.select_element_content = function(element) {
  var range;
  if (window.getSelection) { // FF, Safari, Opera
    var sel = window.getSelection();
    range = document.createRange();
    range.selectNodeContents(element);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    document.selection.empty();
    range = document.body.createTextRange();
    range.moveToElementText(el);
    range.select();
  }
};

// a progress tracker
UTILS.PROGRESS = Class.extend({
  init: function() {
    this.n_ticks = 0.0;
    this.current_tick = 0.0;
  },
  
  addTicks: function(n_ticks) {
    this.n_ticks += n_ticks;
  },
  
  tick: function() {
    this.current_tick += 1.0;
  },
  
  progress: function() {
    return Math.round((this.current_tick / this.n_ticks) * 100);
  }
});

// produce the same object but with keys sorted
UTILS.object_sort_keys = function(obj) {
  var new_obj = {};
  $($.keys(obj)).each(function(i, k) {
    new_obj[k] = obj[k];
  });
  return new_obj;
};

//
// Helios Stuff
//

HELIOS = {};

// election
HELIOS.Election = Class.extend({
  init: function() {
  },
  
  toJSONObject: function() {
    var json_obj = {ballot_type: this.ballot_type, uuid : this.uuid,
    description : this.description, short_name : this.short_name, name : this.name,
    public_key: this.public_key.toJSONObject(), questions : this.questions,
    tally_type: this.tally_type, cast_url: this.cast_url, frozen_at: this.frozen_at,
    openreg: this.openreg, voters_hash: this.voters_hash,
    use_voter_aliases: this.use_voter_aliases};
    
    return UTILS.object_sort_keys(json_obj);
  },
  
  get_hash: function() {
    if (this.election_hash)
      return this.election_hash;
    
    // otherwise  
    return b64_sha256(this.toJSON());
  },
  
  toJSON: function() {
    // FIXME: only way around the backslash thing for now.... how ugly
    //return jQuery.toJSON(this.toJSONObject()).replace(/\//g,"\\/");
    return jQuery.toJSON(this.toJSONObject());
  }
});

HELIOS.Election.fromJSONString = function(raw_json) {
  var json_object = $.secureEvalJSON(raw_json);
  
  // hash fix for the issue with re-json'ifying unicode chars
  var election = HELIOS.Election.fromJSONObject(json_object);
  election.election_hash = b64_sha256(election.toJSON());
  
  return election;
};

HELIOS.Election.fromJSONObject = function(d) {
  var el = new HELIOS.Election();
  jQuery.extend(el, d);
  
  // empty questions
  if (!el.questions)
    el.questions = [];
  
  if (el.public_key)
    el.public_key = ElGamal.PublicKey.fromJSONObject(el.public_key);
    
  return el;
};

HELIOS.Election.setup = function(election) {
  return ELECTION.fromJSONObject(election);
};


// ballot handling
BALLOT = {};

BALLOT.pretty_choices = function(election, ballot) {
    var questions = election.questions;
    var answers = ballot.answers;

    // process the answers
    var choices = $(questions).map(function(q_num) {
	    return $(answers[q_num]).map(function(dummy, ans) {
	      return questions[q_num].answers[ans];
	    });
    });

    return choices;
};


// open up a new window and do something with it.
UTILS.open_window_with_content = function(content) {
    if (BigInt.is_ie) {
	    w = window.open("");
	    w.document.open("text/plain");
	    w.document.write(content);
	    w.document.close();
    } else {
	    w = window.open("data:text/plain," + encodeURIComponent(content));
    }
};

// generate an array of the first few plaintexts
UTILS.generate_plaintexts = function(pk, min, max) {
  var last_plaintext = BigInt.ONE;

  // an array of plaintexts
  var plaintexts = [];
  
  if (min == null)
    min = 0;
  
  // questions with more than one possible answer, add to the array.
  for (var i=0; i<=max; i++) {
    if (i >= min)
      plaintexts.push(new ElGamal.Plaintext(last_plaintext, pk, false));
    last_plaintext = last_plaintext.multiply(pk.g).mod(pk.p);
  }
  
  return plaintexts;
}


//
// crypto
//


HELIOS.EncryptedAnswer = Class.extend({
  init: function(question, answer, pk, progress) {    
    // if nothing in the constructor
    if (question == null)
      return;

    // store answer
    // CHANGE 2008-08-06: answer is now an *array* of answers, not just a single integer
    this.answer = answer;

    // do the encryption
    var enc_result = this.doEncryption(question, answer, pk, null, progress);

    this.choices = enc_result.choices;
    this.randomness = enc_result.randomness;
    this.individual_proofs = enc_result.individual_proofs;
    this.overall_proof = enc_result.overall_proof;    
  },
  
  doEncryption: function(question, answer, pk, randomness, progress) {
    var choices = [];
    var individual_proofs = [];
    var overall_proof = null;
    
    // possible plaintexts [question.min .. , question.max]
    var plaintexts = UTILS.generate_plaintexts(pk, question.min, question.max);
    var zero_one_plaintexts = UTILS.generate_plaintexts(pk, 0, 1);
    
    // keep track of whether we need to generate new randomness
    var generate_new_randomness = false;    
    if (!randomness) {
      randomness = [];
      generate_new_randomness = true;
    }
    
    // keep track of number of options selected.
    var num_selected_answers = 0;
    
    // go through each possible answer and encrypt either a g^0 or a g^1.
    for (var i=0; i<question.answers.length; i++) {
      var index, plaintext_index;
      // if this is the answer, swap them so m is encryption 1 (g)
      if (jQuery.inArray(i, answer) > -1) {
        plaintext_index = 1;
        num_selected_answers += 1;
      } else {
        plaintext_index = 0;
      }

      // generate randomness?
      if (generate_new_randomness) {
        randomness[i] = Random.getRandomInteger(pk.q);        
      }

      choices[i] = ElGamal.encrypt(pk, zero_one_plaintexts[plaintext_index], randomness[i]);
      
      // generate proof
      if (generate_new_randomness) {
        // generate proof that this ciphertext is a 0 or a 1
        individual_proofs[i] = choices[i].generateDisjunctiveProof(zero_one_plaintexts, plaintext_index, randomness[i], ElGamal.disjunctive_challenge_generator);        
      }
      
      if (progress)
        progress.tick();
    }

    if (generate_new_randomness) {
      // we also need proof that the whole thing sums up to the right number
    
      // compute the homomorphic sum of all the options
      var hom_sum = choices[0];
      var rand_sum = randomness[0];
      for (var i=1; i<question.answers.length; i++) {
        hom_sum = hom_sum.multiply(choices[i]);
        rand_sum = rand_sum.add(randomness[i]).mod(pk.q);
      }
    
      // prove that the sum is 0 or 1 (can be "blank vote" for this answer)
      // num_selected_answers is 0 or 1, which is the index into the plaintext that is actually encoded
      //
      // now that "plaintexts" only contains the array of plaintexts that are possible starting with min
      // and going to max, the num_selected_answers needs to be reduced by min to be the proper index
      var overall_plaintext_index = num_selected_answers;
      if (question.min)
        overall_plaintext_index -= question.min;
        
      overall_proof = hom_sum.generateDisjunctiveProof(plaintexts, overall_plaintext_index, rand_sum, ElGamal.disjunctive_challenge_generator);
      if (progress)
        progress.tick();
    }
    
    return {
      'choices' : choices,
      'randomness' : randomness,
      'individual_proofs' : individual_proofs,
      'overall_proof' : overall_proof
    };
  },
  
  clearPlaintexts: function() {
    this.answer = null;
    this.randomness = null;
  },
  
  // FIXME: should verifyEncryption really generate proofs? Overkill.
  verifyEncryption: function(question, pk) {
    var result = this.doEncryption(question, this.answer, pk, this.randomness);

    // check that we have the same number of ciphertexts
    if (result.choices.length != this.choices.length) {
      return false;      
    }
      
    // check the ciphertexts
    for (var i=0; i<result.choices.length; i++) {
      if (!result.choices[i].equals(this.choices[i])) {
        alert ("oy: " + result.choices[i] + "/" + this.choices[i]);
        return false;
      }
    }
    
    // we made it, we're good
    return true;
  },
  
  toString: function() {
    // get each ciphertext as a JSON string
    var choices_strings = jQuery.makeArray($(this.choices).map(function(i,c) {return c.toString();}));
    return choices_strings.join("|");
  },
  
  toJSONObject: function(include_plaintext) {
    var return_obj = {
      'choices' : $(this.choices).map(function(i, choice) {
        return choice.toJSONObject();
      }),
      'individual_proofs' : $(this.individual_proofs).map(function(i, disj_proof) {
        return disj_proof.toJSONObject();
      }),
      'overall_proof' : this.overall_proof.toJSONObject()
    };
    
    if (include_plaintext) {
      return_obj.answer = this.answer;
      return_obj.randomness = $(this.randomness).map(function(i, r) {
        return r.toJSONObject();
      });
    }
    
    return return_obj;
  }
});

HELIOS.EncryptedAnswer.fromJSONObject = function(d, election) {
  var ea = new HELIOS.EncryptedAnswer();
  ea.choices = $(d.choices).map(function(i, choice) {
    return ElGamal.Ciphertext.fromJSONObject(choice, election.public_key);
  });
  
  ea.individual_proofs = $(d.individual_proofs).map(function (i, p) {
    return ElGamal.DisjunctiveProof.fromJSONObject(p);
  });
  
  ea.overall_proof = ElGamal.DisjunctiveProof.fromJSONObject(d.overall_proof);
  
  // possibly load randomness and plaintext
  if (d.randomness) {
    ea.randomness = $(d.randomness).map(function(i, r) {
      return BigInt.fromJSONObject(r);
    });
    ea.answer = d.answer;
  }
  
  return ea;
};

HELIOS.EncryptedVote = Class.extend({
  init: function(election, answers, progress) {
    // empty constructor
    if (election == null)
      return;

    // keep information about the election around
    this.election_uuid = election.uuid;
    this.election_hash = election.get_hash();
    this.election = election;
     
    if (answers == null)
      return;
      
    var n_questions = election.questions.length;
    this.encrypted_answers = [];

    if (progress) {
      // set up the number of ticks
      $(election.questions).each(function(q_num, q) {
        // + 1 for the overall proof
        progress.addTicks(q.answers.length + 1);
      });
    }
    
    progress.addTicks(0, n_questions);
      
    // loop through questions
    for (var i=0; i<n_questions; i++) {
      this.encrypted_answers[i] = new HELIOS.EncryptedAnswer(election.questions[i], answers[i], election.public_key, progress);
    }    
  },
  
  toString: function() {
    // for each question, get the encrypted answer as a string
    var answer_strings = jQuery.makeArray($(this.encrypted_answers).map(function(i,a) {return a.toString();}));
    
    return answer_strings.join("//");
  },
  
  clearPlaintexts: function() {
    $(this.encrypted_answers).each(function(i, ea) {
      ea.clearPlaintexts();
    });
  },
  
  verifyEncryption: function(questions, pk) {
    var overall_result = true;
    $(this.encrypted_answers).each(function(i, ea) {
      overall_result = overall_result && ea.verifyEncryption(questions[i], pk);
    });
    return overall_result;
  },
  
  toJSONObject: function(include_plaintext) {
    var answers = $(this.encrypted_answers).map(function(i,ea) {
      return ea.toJSONObject(include_plaintext);
    });
    
    return {
      answers : answers,
      election_hash : this.election_hash,
      election_uuid : this.election_uuid
    }
  },
  
  get_hash: function() {
    return b64_sha256(jQuery.toJSON(this));
  },
  
  get_audit_trail: function() {
    return this.toJSONObject(true);
  },
  
  verifyProofs: function(pk, outcome_callback) {
    var zero_or_one = UTILS.generate_plaintexts(pk, 0, 1);

    var VALID_P = true;
    
    var self = this;
    
    // for each question and associate encrypted answer
    $(this.encrypted_answers).each(function(ea_num, enc_answer) {
        var overall_result = 1;

        // go through each individual proof
        $(enc_answer.choices).each(function(choice_num, choice) {
          var result = choice.verifyDisjunctiveProof(zero_or_one, enc_answer.individual_proofs[choice_num], ElGamal.disjunctive_challenge_generator);
          outcome_callback(ea_num, choice_num, result, choice);
          
          VALID_P = VALID_P && result;
           
          // keep track of homomorphic product
          overall_result = choice.multiply(overall_result);
        });
        
        // possible plaintexts [0, 1, .. , question.max]
        var plaintexts = UTILS.generate_plaintexts(pk, self.election.questions[ea_num].min, self.election.questions[ea_num].max);
        
        // check the proof on the overall product
        var overall_check = overall_result.verifyDisjunctiveProof(plaintexts, enc_answer.overall_proof, ElGamal.disjunctive_challenge_generator);
        outcome_callback(ea_num, null, overall_check, null);
        VALID_P = VALID_P && overall_check;
    });
    
    return VALID_P;
  }
});

HELIOS.EncryptedVote.fromJSONObject = function(d, election) {
  if (d == null)
    return null;
    
  var ev = new HELIOS.EncryptedVote(election);
  
  ev.encrypted_answers = $(d.answers).map(function(i, ea) {
    return HELIOS.EncryptedAnswer.fromJSONObject(ea, election);
  });
  
  ev.election_hash = d.election_hash;
  ev.election_uuid = d.election_uuid;
  
  return ev;
};

//
// distributed decryption : Trustees
//

// a utility function for jsonifying a list of lists of items
HELIOS.jsonify_list_of_lists = function(lol) {
  if (!lol)
    return null;
    
  return $(lol).map(function(i, sublist) {return $(sublist).map(function(j, item) {return item.toJSONObject();})});
};

// a utility function for doing the opposite with an item-level de-jsonifier
HELIOS.dejsonify_list_of_lists = function(lol, item_dejsonifier) {
  if (!lol)
    return null;
    
  return $(lol).map(function(i, sublist) {return $(sublist).map(function(j, item) {return item_dejsonifier(item);})});
}

HELIOS.Trustee = Class.extend({
  init: function(email, name, public_key, pok, decryption_factors, decryption_proofs) {
    this.email = email;
    this.name = name;
    this.public_key = public_key;
    this.pok = pok;
    this.decryption_factors = decryption_factors;
    this.decryption_proofs = decryption_proofs;
  },
  
  toJSONObject: function() {
    return {
      'decryption_factors' : HELIOS.jsonify_list_of_lists(this.decryption_factors),
      'decryption_proofs' : HELIOS.jsonify_list_of_list(this.decryption_proofs),
      'email' : this.email, 'name' : this.name, 'pok' : this.pok.toJSONObject(), 'public_key' : this.public_key.toJSONObject()
    }
  }
});

HELIOS.Trustee.fromJSONObject = function(d) {
  return new HELIOS.Trustee(d.email, d.name, 
    ElGamal.PublicKey.fromJSONObject(d.public_key), ElGamal.DLogProof.fromJSONObject(d.pok),
    HELIOS.dejsonify_list_of_lists(d.decryption_factors, BigInt.fromJSONObject),
    HELIOS.dejsonify_list_of_lists(d.decryption_proofs, ElGamal.Proof.fromJSONObject));
};